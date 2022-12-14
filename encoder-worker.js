function onerror(e) {
    console.error(e);
    self.postMessage({
        type: 'error',
        detail: e.message
    });
}

onmessage = async function (e) {
    const msg = e.data;
    switch (msg.type) {
        case 'start':
            try {
                const Encoder = msg.audio ? AudioEncoder : VideoEncoder;
                const type = msg.audio ? 'audio-data' : 'video-data';

                let key_frame_interval = msg.audio ? 0 : msg.key_frame_interval;
                if (key_frame_interval > 0) {
                    // Use frame count rather than timestamp to determine key frame.
                    if (msg.count_frames) {
                        //以每秒帧数为单位的预期帧速率（如果已知）。
                        if (!msg.config.framerate) {
                            throw new Error('framerate not configured');
                        }
                    } else {
                        //How often to generate a key frame, in seconds. Use 0 for no key frames.
                        key_frame_interval *= 1000000;
                    }
                }

                let encoder;
                //video或者opus
                if (msg.config.codec !== 'pcm') {
                    //在非pcm的环境下，创建encoder
                    encoder = new Encoder({
                        //encoder的后续操作：encode出的编码块发送给主线程，type是具体的audio-data或者video-data
                        output: chunk => {
                            const data = new ArrayBuffer(chunk.byteLength);
                            chunk.copyTo(data);
                            self.postMessage({
                                type,
                                timestamp: chunk.timestamp,
                                duration: chunk.duration,
                                is_key: msg.audio || chunk.type === 'key',
                                data
                            }, [data]);
                        },
                        error: onerror
                    });
                    //encoder调用configure方法进行配置
                    await encoder.configure(msg.config);
                }

                //msg是什么类型的？
                const reader = msg.readable.getReader();
                let last_key_frame = -1;
                let frame_count = 0;

                while (true) {
                    const result = await reader.read();
                    if (result.done) {
                        if (encoder) {
                            
                            await encoder.flush();
                        }
                        //如果当前encoder编码完成，给主线程发送消息exit
                        self.postMessage({ type: 'exit' });
                        break;
                    }
                    //if msg.audio is true then ,msg.video is false
                    if (msg.audio) {
                        if (encoder) {
                            //第十步，直接进行ecode（对于非pcm的音频）
                            encoder.encode(result.value);
                            //似乎是只支持f32-planar
                        } else if (result.value.format !== 'f32-planar') {
                            throw new Error(`unexpected audio format: ${result.value.format}`);
                        } else {
                            //是pcm而且format === f32-planner要在这里经过一个格式转换的过程
                            // Convert from planar to interleaved
                            const nc = result.value.numberOfChannels;
                            let total_size = 0;
                            const bufs = [];
                            for (let i = 0; i < nc; ++i) {
                                const options = { planeIndex: i };
                                const size = result.value.allocationSize(options);
                                total_size += size;
                                const buf = new ArrayBuffer(size);
                                result.value.copyTo(buf, options);
                                bufs.push(buf);
                            }
                            const data = new ArrayBuffer(total_size);
                            const buf = new Uint8Array(data);
                            for (let i = 0; i < total_size; i += 4) {
                                const d = i / 4;
                                buf.set(new Uint8Array(bufs[Math.floor(d) % nc], Math.floor(d / nc) * 4, 4), i);
                            }
                            //第十步：发送给主线程音频信息
                            self.postMessage({
                                type,
                                timestamp: result.value.timestamp,
                                duration: result.value.duration,
                                is_key: true,
                                data
                            }, [data]);
                        }
                    } else {
                        let keyFrame = false;
                        if (key_frame_interval > 0) {
                            if (msg.count_frames) {
                                keyFrame = frame_count++ % (msg.config.framerate * key_frame_interval) == 0;
                            } else if ((last_key_frame < 0) ||
                                       ((result.value.timestamp - last_key_frame) > key_frame_interval)) {
                                keyFrame = true;
                                last_key_frame = result.value.timestamp;
                            }
                        }
                        //进行decode（对于视频）
                        encoder.encode(result.value, { keyFrame });
                    }
                    result.value.close();
                }
            } catch (ex) {
                onerror(ex);
            }

            break;
    }
};
