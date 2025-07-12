// ==UserScript==
// @name         Twitter Smart Export - 推特智能导出工具
// @namespace    https://github.com/yourusername
// @version      6.0.0
// @description  Smart export tweets with date filter and streaming ZIP
// @description:zh-CN  智能导出推文，支持日期筛选和流式ZIP打包，包含图片下载
// @author       Your Name
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// @run-at       document-start
// ==/UserScript==

// 通用重试函数
async function retryOperation(operation, maxRetries = 3, retryDelay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            console.log(`操作失败，尝试 ${attempt}/${maxRetries}，错误: ${error.message}`);

            // 如果不是最后一次尝试，则等待后重试
            if (attempt < maxRetries) {
                // 增加递增的延迟时间，每次失败后等待更长时间
                const currentDelay = retryDelay * attempt;
                await new Promise(resolve => setTimeout(resolve, currentDelay));
            }
        }
    }

    // 所有重试都失败，抛出最后一个错误，并附加重试信息
    const enhancedError = new Error(`在 ${maxRetries} 次尝试后失败: ${lastError.message}`);
    enhancedError.originalError = lastError;
    throw enhancedError;
}

(function () {
    'use strict';

    // 全局变量
    const capturedTweets = new Map();
    let currentUsername = '';
    let isAutoScrolling = false;
    let autoScrollInterval = null;
    let targetDate = null;
    let isExporting = false;

    // ===== 流式ZIP处理所需的类和函数 =====

    // CRC32表预计算
    const CRC32_TABLE = (function () {
        let table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let t = i;
            for (let j = 0; j < 8; j++) {
                if (t & 1) {
                    t = (t >>> 1) ^ 0xEDB88320;
                } else {
                    t = t >>> 1;
                }
            }
            table[i] = t;
        }
        return table;
    })();

    // 二进制数据辅助对象
    const getDataHelper = (byteLength) => {
        const uint8 = new Uint8Array(byteLength);
        return {
            array: uint8,
            view: new DataView(uint8.buffer)
        };
    };

    // 从流中读取数据块
    const pump = (zipObj) => zipObj.reader.read().then((chunk) => {
        if (chunk.done) return zipObj.writeFooter();
        const outputData = chunk.value;
        zipObj.crc.append(outputData);
        zipObj.uncompressedLength += outputData.length;
        zipObj.compressedLength += outputData.length;
        zipObj.ctrl.enqueue(outputData);
    });

    // CRC32计算类
    class Crc32 {
        constructor() {
            this.crc = -1;
        }

        append(data) {
            let crc = this.crc | 0;
            for (let offset = 0; offset < data.length; offset++) {
                crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[offset]) & 0xFF];
            }
            this.crc = crc;
        }

        get() {
            return ~this.crc;
        }
    }

    // 创建ZIP流写入器
    function createWriter(underlyingSource) {
        const files = Object.create(null);
        const filenames = [];
        const encoder = new TextEncoder();
        let offset = 0;
        let activeZipIndex = 0;
        let ctrl;
        let activeZipObject, closed;

        function next() {
            activeZipIndex++;
            activeZipObject = files[filenames[activeZipIndex]];
            if (activeZipObject) processNextChunk();
            else if (closed) closeZip();
        }

        var zipWriter = {
            enqueue(fileLike) {
                if (closed) {
                    throw new TypeError("无法向已关闭的流添加数据");
                }

                let name = fileLike.name.trim();
                const date = new Date(
                    typeof fileLike.lastModified === "undefined" ? Date.now() : fileLike.lastModified
                );

                if (fileLike.directory && !name.endsWith("/")) name += "/";
                if (files[name]) throw new Error("文件已存在");

                const nameBuf = encoder.encode(name);
                filenames.push(name);

                const zipObject = files[name] = {
                    level: 0,
                    ctrl,
                    directory: !!fileLike.directory,
                    nameBuf,
                    comment: encoder.encode(fileLike.comment || ""),
                    compressedLength: 0,
                    uncompressedLength: 0,
                    writeHeader() {
                        var header = getDataHelper(26);
                        var data = getDataHelper(30 + nameBuf.length);
                        zipObject.offset = offset;
                        zipObject.header = header;

                        if (zipObject.level !== 0 && !zipObject.directory) {
                            header.view.setUint16(4, 2048);
                        }

                        header.view.setUint32(0, 335546376);
                        header.view.setUint16(
                            6,
                            (date.getHours() << 6 | date.getMinutes()) << 5 | date.getSeconds() / 2,
                            true
                        );
                        header.view.setUint16(
                            8,
                            (date.getFullYear() - 1980 << 4 | date.getMonth() + 1) << 5 | date.getDate(),
                            true
                        );
                        header.view.setUint16(22, nameBuf.length, true);
                        data.view.setUint32(0, 1347093252);
                        data.array.set(header.array, 4);
                        data.array.set(nameBuf, 30);
                        offset += data.array.length;
                        ctrl.enqueue(data.array);
                    },
                    writeFooter() {
                        var footer = getDataHelper(16);
                        footer.view.setUint32(0, 1347094280);
                        if (zipObject.crc) {
                            zipObject.header.view.setUint32(10, zipObject.crc.get(), true);
                            zipObject.header.view.setUint32(14, zipObject.compressedLength, true);
                            zipObject.header.view.setUint32(18, zipObject.uncompressedLength, true);
                            footer.view.setUint32(4, zipObject.crc.get(), true);
                            footer.view.setUint32(8, zipObject.compressedLength, true);
                            footer.view.setUint32(12, zipObject.uncompressedLength, true);
                        }
                        ctrl.enqueue(footer.array);
                        offset += zipObject.compressedLength + 16;
                        next();
                    },
                    fileLike
                };

                if (!activeZipObject) {
                    activeZipObject = zipObject;
                    processNextChunk();
                }
            },
            close() {
                if (closed) {
                    throw new TypeError("无法关闭已经请求关闭的流");
                }
                if (!activeZipObject) closeZip();
                closed = true;
            }
        };

        function closeZip() {
            var length = 0;
            var index = 0;
            var indexFilename, file;

            for (indexFilename = 0; indexFilename < filenames.length; indexFilename++) {
                file = files[filenames[indexFilename]];
                length += 46 + file.nameBuf.length + file.comment.length;
            }

            const data = getDataHelper(length + 22);

            for (indexFilename = 0; indexFilename < filenames.length; indexFilename++) {
                file = files[filenames[indexFilename]];
                data.view.setUint32(index, 1347092738);
                data.view.setUint16(index + 4, 5120);
                data.array.set(file.header.array, index + 6);
                data.view.setUint16(index + 32, file.comment.length, true);

                if (file.directory) {
                    data.view.setUint8(index + 38, 16);
                }

                data.view.setUint32(index + 42, file.offset, true);
                data.array.set(file.nameBuf, index + 46);
                data.array.set(file.comment, index + 46 + file.nameBuf.length);
                index += 46 + file.nameBuf.length + file.comment.length;
            }

            data.view.setUint32(index, 1347093766);
            data.view.setUint16(index + 8, filenames.length, true);
            data.view.setUint16(index + 10, filenames.length, true);
            data.view.setUint32(index + 12, length, true);
            data.view.setUint32(index + 16, offset, true);
            ctrl.enqueue(data.array);
            ctrl.close();
        }

        function processNextChunk() {
            if (!activeZipObject) return;

            if (activeZipObject.directory)
                return activeZipObject.writeFooter(activeZipObject.writeHeader());

            if (activeZipObject.reader) return pump(activeZipObject);

            if (activeZipObject.fileLike.stream) {
                activeZipObject.crc = new Crc32();
                activeZipObject.reader = activeZipObject.fileLike.stream().getReader();
                activeZipObject.writeHeader();
            } else next();
        }

        return new ReadableStream({
            start: (c) => {
                ctrl = c;
                if (underlyingSource.start) Promise.resolve(underlyingSource.start(zipWriter));
            },
            pull() {
                return processNextChunk() || underlyingSource.pull && Promise.resolve(underlyingSource.pull(zipWriter));
            }
        });
    }

    // 流式ZIP下载函数
    async function zipStreamDownload(zipFilename, files, onProgress, rateLimit = 1000) {
        let current = 0;
        const total = files.length;
        const fileIterator = files.values();
        let failedFiles = 0;

        const readableZipStream = createWriter({
            async pull(ctrl) {
                const fileInfo = fileIterator.next();
                if (fileInfo.done) {
                    ctrl.close();
                } else {
                    const { filename, content, blob, url } = fileInfo.value;
                    const start = Date.now();

                    // 处理文本内容
                    if (content) {
                        try {
                            console.log(`添加文本文件 ${filename}`);
                            const encoder = new TextEncoder();
                            const textData = encoder.encode(content);
                            ctrl.enqueue({
                                name: filename,
                                stream: () => new ReadableStream({
                                    start(controller) {
                                        controller.enqueue(textData);
                                        controller.close();
                                    }
                                })
                            });
                            onProgress?.(++current, total, fileInfo.value, true);
                            console.log(`完成添加文本文件 ${filename}`);
                        } catch (error) {
                            console.error(`添加文本文件失败 ${filename}:`, error);
                            failedFiles++;

                            // 添加错误信息文件
                            const errorMessage = `添加文件失败: ${error.message || '未知错误'}\n原始内容长度: ${content?.length || 0}`;
                            const errorData = new TextEncoder().encode(errorMessage);

                            try {
                                ctrl.enqueue({
                                    name: `${filename}.error.txt`,
                                    stream: () => new ReadableStream({
                                        start(controller) {
                                            controller.enqueue(errorData);
                                            controller.close();
                                        }
                                    })
                                });
                                onProgress?.(++current, total, { filename: `${filename}.error.txt` }, false);
                            } catch (e) {
                                console.error('添加错误信息文件也失败了:', e);
                            }
                        }
                        return new Promise((resolve) => setTimeout(resolve, 10)); // 短暂延迟
                    }

                    // 处理已有的Blob数据
                    if (blob) {
                        try {
                            console.log(`添加Blob文件 ${filename}`);
                            ctrl.enqueue({
                                name: filename,
                                stream: () => new ReadableStream({
                                    start(controller) {
                                        try {
                                            controller.enqueue(new Uint8Array(blob));
                                            controller.close();
                                        } catch (error) {
                                            console.error(`处理Blob数据失败 ${filename}:`, error);
                                            controller.close();
                                        }
                                    }
                                })
                            });
                            onProgress?.(++current, total, fileInfo.value, true);
                            console.log(`完成添加Blob文件 ${filename}`);
                        } catch (error) {
                            console.error(`添加Blob文件失败 ${filename}:`, error);
                            failedFiles++;

                            // 添加错误信息文件
                            const errorMessage = `添加文件失败: ${error.message || '未知错误'}\n文件大小: ${blob?.size || 0}`;
                            const errorData = new TextEncoder().encode(errorMessage);

                            try {
                                ctrl.enqueue({
                                    name: `${filename}.error.txt`,
                                    stream: () => new ReadableStream({
                                        start(controller) {
                                            controller.enqueue(errorData);
                                            controller.close();
                                        }
                                    })
                                });
                                onProgress?.(++current, total, { filename: `${filename}.error.txt` }, false);
                            } catch (e) {
                                console.error('添加错误信息文件也失败了:', e);
                            }
                        }
                        return new Promise((resolve) => setTimeout(resolve, rateLimit * Math.random())); // 随机延迟
                    }

                    // 处理媒体文件下载
                    if (url) {
                        console.log(`开始下载 ${filename} 从 ${url}`);

                        try {
                            // 使用重试函数包装下载操作
                            const responseBlob = await retryOperation(async (attempt) => {
                                console.log(`尝试下载 ${filename}，第 ${attempt} 次`);

                                // 创建一个超时Promise
                                const timeoutPromise = new Promise((_, reject) => {
                                    setTimeout(() => reject(new Error('下载超时')), 5000); // 5秒超时
                                });

                                // 使用GM_xmlhttpRequest进行请求，并添加超时竞争
                                const requestPromise = new Promise((resolve, reject) => {
                                    const requestId = GM_xmlhttpRequest({
                                        method: 'GET',
                                        url: url,
                                        responseType: 'blob',
                                        timeout: 5000, // 5秒超时
                                        onload: function (response) {
                                            if (response.status >= 200 && response.status < 300) {
                                                resolve(response.response);
                                            } else {
                                                reject(new Error(`HTTP错误状态码: ${response.status}`));
                                            }
                                        },
                                        onerror: function (error) {
                                            reject(new Error(`下载错误: ${error?.message || '未知错误'}`));
                                        },
                                        ontimeout: function () {
                                            reject(new Error('请求超时'));
                                        }
                                    });
                                });

                                // 竞争Promise，谁先完成就用谁的结果
                                return await Promise.race([requestPromise, timeoutPromise]);
                            }, 3, 1000); // 最多重试3次，每次重试间隔1秒

                            // 成功获取到blob数据
                            const fileStreamPromise = new Promise((resolve, reject) => {
                                // 内部超时保护，防止FileReader卡住
                                const innerTimeout = setTimeout(() => {
                                    reject(new Error('FileReader处理超时'));
                                }, 5000); // 5秒超时，与下载超时时间保持一致

                                try {
                                    ctrl.enqueue({
                                        name: filename,
                                        stream: () => new ReadableStream({
                                            start(controller) {
                                                // 转换Blob为Uint8Array
                                                const reader = new FileReader();
                                                reader.onload = () => {
                                                    try {
                                                        controller.enqueue(new Uint8Array(reader.result));
                                                        controller.close();
                                                        clearTimeout(innerTimeout);
                                                        resolve();
                                                    } catch (error) {
                                                        console.error(`处理文件数据失败 ${filename}:`, error);
                                                        controller.close();
                                                        clearTimeout(innerTimeout);
                                                        reject(error);
                                                    }
                                                };
                                                reader.onerror = (error) => {
                                                    console.error(`FileReader错误 ${filename}:`, error);
                                                    controller.close();
                                                    clearTimeout(innerTimeout);
                                                    reject(new Error(`FileReader错误: ${error?.message || '未知错误'}`));
                                                };

                                                try {
                                                    reader.readAsArrayBuffer(responseBlob);
                                                } catch (error) {
                                                    console.error(`调用readAsArrayBuffer失败 ${filename}:`, error);
                                                    controller.close();
                                                    clearTimeout(innerTimeout);
                                                    reject(error);
                                                }
                                            }
                                        })
                                    });
                                } catch (error) {
                                    clearTimeout(innerTimeout);
                                    reject(error);
                                }
                            });

                            // 设置总体超时
                            const overallTimeoutPromise = new Promise((_, reject) => {
                                setTimeout(() => reject(new Error('整体处理超时')), 10000); // 10秒总超时，考虑到重试后的总时间控制
                            });

                            // 等待文件流处理完成或超时
                            await Promise.race([fileStreamPromise, overallTimeoutPromise]);

                            onProgress?.(++current, total, fileInfo.value, true);
                            console.log(`完成下载 ${filename} 耗时 ${Date.now() - start}ms`);
                        } catch (error) {
                            // 添加重试次数信息到错误日志
                            const retryInfo = error.originalError ? `(已重试3次)` : '';
                            console.error(`下载或处理 ${filename} 失败 ${retryInfo}:`, error);
                            failedFiles++;

                            // 添加错误信息文件，包含重试信息
                            const originalError = error.originalError ? error.originalError.message : error.message;
                            const errorMessage = `下载文件失败 ${retryInfo}: ${originalError || '未知错误'}\n文件URL: ${url}`;
                            const errorData = new TextEncoder().encode(errorMessage);

                            try {
                                ctrl.enqueue({
                                    name: `${filename}.error.txt`,
                                    stream: () => new ReadableStream({
                                        start(controller) {
                                            controller.enqueue(errorData);
                                            controller.close();
                                        }
                                    })
                                });
                                onProgress?.(++current, total, { filename: `${filename}.error.txt` }, false);
                            } catch (e) {
                                console.error('添加错误信息文件也失败了:', e);
                            }
                        }

                        // 无论成功还是失败，都添加延迟以避免过度请求
                        return new Promise((resolve) => setTimeout(resolve, rateLimit * (0.5 + Math.random())));
                    }
                }
            }
        });

        // 收集输出的数据块
        const chunks = [];
        const writableOutputStream = new WritableStream({
            write(chunk) {
                chunks.push(chunk);
            },
            close() {
                console.log(`ZIP流已关闭。处理文件总数: ${total}, 失败: ${failedFiles}`);
                if (failedFiles > 0) {
                    console.warn(`有${failedFiles}个文件处理失败，已添加错误信息文件`);
                }
            }
        });

        console.log(`导出到ZIP文件: ${zipFilename}`);

        // 使用流管道
        await readableZipStream.pipeTo(writableOutputStream);

        // 创建最终的Blob并下载
        const arrayBuffer = await new Blob(chunks).arrayBuffer();
        const blob = new Blob([arrayBuffer]);
        saveAs(blob, zipFilename);

        return { total, failed: failedFiles };
    }

    // 添加样式
    GM_addStyle(`
        .smart-export-widget {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            background: rgba(0, 0, 0, 0.9);
            backdrop-filter: blur(10px);
            border-radius: 16px;
            padding: 20px;
            min-width: 280px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .export-header {
            color: white;
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-indicator {
            width: 8px;
            height: 8px;
            background: #00ba7c;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.2); }
        }

        .export-stats {
            color: rgba(255, 255, 255, 0.8);
            font-size: 14px;
            margin-bottom: 16px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }

        .stat-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 8px 12px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .stat-label {
            color: rgba(255, 255, 255, 0.6);
            font-size: 12px;
        }

        .stat-value {
            font-weight: 700;
            color: #1d9bf0;
        }

        .media-value {
            color: #f91880;
        }

        .date-picker-container {
            margin-bottom: 16px;
        }

        .date-picker-label {
            color: rgba(255, 255, 255, 0.8);
            font-size: 12px;
            margin-bottom: 8px;
            display: block;
        }

        .date-picker {
            width: 100%;
            padding: 10px 12px;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            color: white;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .date-picker:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.3);
        }

        .date-picker:focus {
            outline: none;
            border-color: #1d9bf0;
            box-shadow: 0 0 0 2px rgba(29, 155, 240, 0.2);
        }

        .export-btn {
            width: 100%;
            background: #1d9bf0;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 24px;
            cursor: pointer;
            font-weight: 600;
            font-size: 15px;
            transition: all 0.2s;
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        .export-btn:hover {
            background: #1a8cd8;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(29, 155, 240, 0.4);
        }

        .export-btn:active {
            transform: translateY(0);
        }

        .export-btn.loading {
            background: #536471;
            cursor: not-allowed;
            pointer-events: none;
        }

        .export-btn .icon {
            width: 20px;
            height: 20px;
        }

        .loading-spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .progress-info {
            color: rgba(255, 255, 255, 0.8);
            font-size: 12px;
            margin-top: 12px;
            text-align: center;
            min-height: 20px;
        }

        .floating-message {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 16px 24px;
            border-radius: 12px;
            font-size: 14px;
            z-index: 10001;
            transform: translateX(400px);
            transition: transform 0.3s;
            max-width: 300px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .floating-message.show {
            transform: translateX(0);
        }

        .floating-message.success {
            background: rgba(0, 186, 124, 0.9);
            border-color: rgba(0, 186, 124, 0.3);
        }

        .floating-message.error {
            background: rgba(244, 33, 46, 0.9);
            border-color: rgba(244, 33, 46, 0.3);
        }

        .floating-message.warning {
            background: rgba(255, 173, 31, 0.9);
            border-color: rgba(255, 173, 31, 0.3);
        }

        .minimize-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 24px;
            height: 24px;
            background: rgba(255, 255, 255, 0.1);
            border: none;
            border-radius: 50%;
            color: rgba(255, 255, 255, 0.6);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            font-size: 16px;
            line-height: 1;
        }

        .minimize-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            color: white;
        }

        .smart-export-widget.minimized {
            padding: 12px;
            min-width: auto;
        }

        .smart-export-widget.minimized > *:not(.minimize-btn):not(.export-header) {
            display: none;
        }

        .smart-export-widget.minimized .export-header {
            margin-bottom: 0;
        }
    `);

    // 创建UI组件
    function createUI() {
        const widget = document.createElement('div');
        widget.className = 'smart-export-widget';
        widget.innerHTML = `
            <button class="minimize-btn" title="最小化">−</button>
            <div class="export-header">
                <span class="status-indicator"></span>
                <span>推特智能导出</span>
            </div>
            <div class="export-stats">
                <div class="stat-item">
                    <span class="stat-label">推文</span>
                    <span class="stat-value tweet-count">0</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">媒体</span>
                    <span class="stat-value media-value media-count">0</span>
                </div>
            </div>
            <div class="date-picker-container">
                <label class="date-picker-label">选择开始日期（从该日期到今天）</label>
                <input type="date" class="date-picker" id="export-date-picker">
            </div>
            <button class="export-btn" id="export-button">
                <span class="icon">📦</span>
                <span>流式导出</span>
            </button>
            <button class="export-btn" id="text-export-button" style="margin-top: 10px; background: #6e767d;">
                <span class="icon">📄</span>
                <span>导出为文本</span>
            </button>
            <button class="export-btn" id="debug-button" style="margin-top: 10px; background: #6e767d;">
                <span class="icon">🔍</span>
                <span>调试信息</span>
            </button>
            <div class="progress-info"></div>
        `;
        document.body.appendChild(widget);

        // 设置默认日期为3天前
        const datePicker = document.getElementById('export-date-picker');
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        datePicker.value = threeDaysAgo.toISOString().split('T')[0];
        datePicker.max = new Date().toISOString().split('T')[0];

        // 添加调试按钮功能
        document.getElementById('debug-button').addEventListener('click', () => {
            // 显示调试信息
            const debugInfo = {
                currentUsername: currentUsername,
                capturedTweetsCount: capturedTweets.size,
                tweetIds: Array.from(capturedTweets.keys()).slice(0, 10), // 显示前10个
                browserInfo: navigator.userAgent,
                webStreamsSupport: typeof ReadableStream !== 'undefined' ? '支持' : '不支持',
                timestamp: new Date().toISOString()
            };

            console.log('调试信息:', debugInfo);

            // 创建调试报告
            const report = [
                '## 调试信息',
                '```json',
                JSON.stringify(debugInfo, null, 2),
                '```',
                '',
                '## 捕获的推文示例',
                '```json',
                JSON.stringify(Array.from(capturedTweets.values()).slice(0, 3), null, 2),
                '```'
            ].join('\n');

            // 下载调试报告
            const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
            saveAs(blob, `twitter-debug-${currentUsername}-${Date.now()}.txt`);

            showMessage('已下载调试信息', 'info');
        });

        // 绑定事件
        document.getElementById('export-button').addEventListener('click', handleExport);
        document.getElementById('text-export-button').addEventListener('click', handleTextExport);

        // 最小化按钮
        widget.querySelector('.minimize-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            widget.classList.toggle('minimized');
            e.target.textContent = widget.classList.contains('minimized') ? '+' : '−';
        });

        // 点击widget展开
        widget.addEventListener('click', (e) => {
            if (widget.classList.contains('minimized') && e.target !== widget.querySelector('.minimize-btn')) {
                widget.classList.remove('minimized');
                widget.querySelector('.minimize-btn').textContent = '−';
            }
        });
    }

    // 显示浮动消息
    function showMessage(text, type = 'info') {
        const msg = document.createElement('div');
        msg.className = `floating-message ${type}`;
        msg.textContent = text;
        document.body.appendChild(msg);

        setTimeout(() => msg.classList.add('show'), 10);
        setTimeout(() => {
            msg.classList.remove('show');
            setTimeout(() => msg.remove(), 300);
        }, 3000);
    }

    // 更新进度信息
    function updateProgress(text) {
        document.querySelector('.progress-info').textContent = text;
    }

    // 更新统计信息
    function updateStats() {
        const tweets = Array.from(capturedTweets.values());
        const tweetCount = tweets.length;
        const mediaCount = tweets.reduce((sum, tweet) => sum + tweet.media.length, 0);

        document.querySelector('.tweet-count').textContent = tweetCount;
        document.querySelector('.media-count').textContent = mediaCount;
    }

    // 检测当前页面是否是用户主页
    function isUserProfilePage() {
        const path = window.location.pathname;
        // 匹配用户主页URL模式
        // 例如: /username 或 /username/ 或 /username/with_replies 等
        const match = path.match(/^\/([a-zA-Z0-9_]+)(\/|$)/);
        if (match && !['home', 'explore', 'notifications', 'messages', 'bookmarks', 'lists', 'topics', 'compose', 'search', 'settings', 'i'].includes(match[1])) {
            currentUsername = match[1];
            console.log(`[页面检测] 当前是用户主页: @${currentUsername}`);
            return true;
        }
        console.log(`[页面检测] 当前不是用户主页: ${path}`);
        return false;
    }

    // 获取随机延迟（防止被限流）
    function getRandomDelay() {
        // 基础延迟 1-3 秒
        const base = 1000 + Math.random() * 2000;
        // 20% 概率增加额外延迟（模拟人类行为）
        if (Math.random() < 0.2) {
            return base + Math.random() * 3000;
        }
        return base;
    }

    // 随机滚动距离
    function randomScroll() {
        // 80% 概率正常滚动到底部
        if (Math.random() < 0.8) {
            window.scrollTo(0, document.body.scrollHeight);
        } else {
            // 20% 概率滚动到中间位置（模拟查看内容）
            const randomPosition = document.body.scrollHeight * (0.7 + Math.random() * 0.3);
            window.scrollTo(0, randomPosition);
            // 稍后再滚动到底部
            setTimeout(() => {
                window.scrollTo(0, document.body.scrollHeight);
            }, 500 + Math.random() * 500);
        }
    }

    // 智能滚动加载
    async function smartAutoScroll() {
        return new Promise((resolve) => {
            isAutoScrolling = true;
            let lastHeight = 0;
            let noNewContentCount = 0;
            let scrollCount = 0;
            let pauseCount = 0;
            let totalAttempts = 0;
            const maxAttempts = 50; // 最大尝试次数
            let lastTweetCount = 0;

            // 记录滚动开始时间，用于计算总滚动时间
            const startTime = Date.now();

            // 记录最近几次的推文数量，用于判断是否仍在有效加载
            const recentCounts = [];

            const scrollStep = () => {
                if (!isAutoScrolling) {
                    resolve();
                    return;
                }

                // 检查总尝试次数
                totalAttempts++;
                if (totalAttempts > maxAttempts) {
                    console.log(`达到最大尝试次数(${maxAttempts})，停止滚动`);
                    isAutoScrolling = false;
                    updateProgress(`已尝试${maxAttempts}次，停止加载`);
                    resolve();
                    return;
                }

                // 显示滚动时间
                const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                updateProgress(`正在加载...(${elapsedSeconds}秒) 已获取 ${capturedTweets.size} 条推文 (尝试:${totalAttempts}/${maxAttempts})`);

                randomScroll();
                scrollCount++;

                // 每8次滚动后休息一下，减少频率提高稳定性
                if (scrollCount % 8 === 0) {
                    pauseCount++;
                    updateProgress(`正在加载暂停中... (第 ${pauseCount} 次休息，已获取 ${capturedTweets.size} 条推文)`);
                    setTimeout(() => {
                        if (isAutoScrolling) scrollStep();
                    }, 5000 + Math.random() * 3000); // 休息5-8秒
                    return;
                }

                // 检查是否达到目标日期
                if (targetDate && checkReachedTargetDate()) {
                    isAutoScrolling = false;
                    updateProgress('已加载到目标日期');
                    resolve();
                    return;
                }

                // 检查是否有新内容
                setTimeout(() => {
                    const currentHeight = document.body.scrollHeight;
                    const currentTweetCount = capturedTweets.size;

                    // 记录最近的推文数量
                    recentCounts.push(currentTweetCount);
                    if (recentCounts.length > 5) recentCounts.shift();

                    // 检查最近5次的推文数量是否有变化
                    const isStagnant = recentCounts.length >= 5 &&
                        recentCounts.every(count => count === recentCounts[0]);

                    if (currentHeight === lastHeight && currentTweetCount === lastTweetCount) {
                        noNewContentCount++;
                        console.log(`无新内容 ${noNewContentCount}/10, 高度=${currentHeight}, 推文数=${currentTweetCount}`);

                        // 增加无新内容的次数上限，从5次增加到10次
                        if (noNewContentCount > 10 || isStagnant) {
                            isAutoScrolling = false;
                            updateProgress(`加载完成，共获取 ${capturedTweets.size} 条推文`);
                            console.log(`停止滚动：无新内容次数=${noNewContentCount}，推文数停滞=${isStagnant}`);
                            resolve();
                            return;
                        }

                        // 尝试不同的滚动策略，帮助触发加载
                        if (noNewContentCount > 5) {
                            console.log("尝试备用滚动策略");
                            // 先向上滚动一点再向下滚动
                            window.scrollTo(0, Math.max(0, window.scrollY - 1000));
                            setTimeout(() => {
                                window.scrollTo(0, document.body.scrollHeight);
                            }, 500);
                        }
                    } else {
                        noNewContentCount = 0;
                        lastHeight = currentHeight;
                        lastTweetCount = currentTweetCount;
                        updateStats();
                    }

                    // 继续滚动
                    if (isAutoScrolling) {
                        setTimeout(scrollStep, getRandomDelay());
                    }
                }, 1500); // 增加到1.5秒，给页面更多时间加载
            };

            // 开始滚动
            updateProgress('开始智能加载...');
            scrollStep();
        });
    }

    // 检查是否达到目标日期
    function checkReachedTargetDate() {
        if (!targetDate) return false;

        const tweets = Array.from(capturedTweets.values());
        const oldestTweet = tweets.sort((a, b) => a.timestamp - b.timestamp)[0];

        if (oldestTweet) {
            const oldestDate = new Date(oldestTweet.created_at);
            return oldestDate <= targetDate;
        }

        return false;
    }

    // 处理导出
    async function handleExport() {
        if (isExporting || isAutoScrolling) {
            showMessage('正在处理中，请稍候...', 'warning');
            return;
        }

        // 获取目标日期
        const dateValue = document.getElementById('export-date-picker').value;
        targetDate = dateValue ? new Date(dateValue + 'T23:59:59') : null;

        const exportBtn = document.getElementById('export-button');
        exportBtn.classList.add('loading');
        exportBtn.innerHTML = '<div class="loading-spinner"></div><span>处理中...</span>';
        isExporting = true;

        // 添加超时保护机制
        let exportTimeout = setTimeout(() => {
            if (isExporting) {
                showMessage('导出操作超时，请重试或减少导出数量', 'warning');
                console.warn('导出操作超时，强制终止');

                // 恢复按钮状态
                isExporting = false;
                exportBtn.classList.remove('loading');
                exportBtn.innerHTML = '<span class="icon">📦</span><span>流式导出</span>';
                updateProgress('导出超时，已终止');
            }
        }, 180000); // 3分钟超时

        try {
            // 1. 自动滚动加载
            showMessage('开始智能加载推文...', 'info');
            await smartAutoScroll();

            // 2. 筛选符合日期的推文
            let tweets = Array.from(capturedTweets.values());
            if (targetDate) {
                const originalCount = tweets.length;
                tweets = tweets.filter(tweet => {
                    const tweetDate = new Date(tweet.created_at);
                    return tweetDate >= targetDate;
                });

                // 调试信息
                console.log(`原始推文数: ${originalCount}, 筛选后: ${tweets.length}, 目标日期: ${targetDate}`);

                // 如果选择了未来日期，给出提示
                if (targetDate > new Date()) {
                    showMessage('您选择了未来的日期，请选择过去的日期', 'error');
                    return;
                }
            }

            if (tweets.length === 0) {
                if (capturedTweets.size === 0) {
                    showMessage('请先滚动页面加载一些推文，或等待页面自动加载', 'error');
                } else {
                    showMessage(`没有符合条件的推文。已捕获 ${capturedTweets.size} 条推文，但都不在所选日期范围内`, 'error');
                }

                // 恢复按钮状态
                isExporting = false;
                exportBtn.classList.remove('loading');
                exportBtn.innerHTML = '<span class="icon">📦</span><span>流式导出</span>';
                updateProgress('');
                return;
            }

            showMessage(`正在导出 ${tweets.length} 条推文...`, 'info');

            // 3. 准备文件列表
            const files = prepareTweetFiles(tweets);

            if (files.length === 0) {
                showMessage('没有可导出的文件', 'error');
                return;
            }

            console.log(`准备导出 ${files.length} 个文件`);

            // 4. 创建并下载ZIP文件
            showMessage('开始流式导出，请耐心等待...', 'info');

            // 创建带有进度跟踪的回调函数
            const onProgress = (current, total, file, success) => {
                const percent = (current / total * 100).toFixed(1);
                updateProgress(`导出进度: ${percent}% (${current}/${total})`);

                if (file && file.filename) {
                    const shortName = file.filename.split('/').pop() || file.filename;
                    if (success) {
                        console.log(`处理: ${shortName} (${current}/${total})`);
                    } else {
                        console.warn(`处理失败: ${shortName} (${current}/${total})`);
                        showMessage(`文件 ${shortName} 处理失败，已跳过`, 'warning');
                    }
                }
            };

            // 使用流式导出
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${currentUsername}_tweets_${timestamp}.zip`;

            try {
                const result = await zipStreamDownload(filename, files, onProgress, 500); // 限制请求速率为500ms

                // 根据失败文件数量决定显示不同的消息
                if (result.failed === 0) {
                    showMessage(`导出成功！共导出 ${tweets.length} 条推文`, 'success');
                } else {
                    showMessage(`导出完成，但有 ${result.failed} 个文件失败，已替换为错误信息文件`, 'warning');
                }
            } catch (zipError) {
                console.error('流式ZIP导出失败:', zipError);
                showMessage('ZIP导出失败，请重试或减少导出数量', 'warning');
            }

            updateProgress('导出完成');

        } catch (error) {
            console.error('导出失败:', error);
            showMessage('导出失败，请查看控制台', 'error');
            updateProgress('');
        } finally {
            // 清除超时计时器
            clearTimeout(exportTimeout);

            isExporting = false;
            exportBtn.classList.remove('loading');
            exportBtn.innerHTML = '<span class="icon">📦</span><span>流式导出</span>';
        }
    }

    // 准备推文数据用于导出
    function prepareTweetFiles(tweets) {
        const files = [];
        let processedCount = 0;
        let errorCount = 0;
        const total = tweets.length;

        // 处理所有推文，不再限制数量
        const processingTweets = tweets;

        for (const tweet of processingTweets) {
            try {
                processedCount++;
                const date = new Date(tweet.created_at);
                const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
                const folderName = `${dateStr}_${tweet.id}`;

                // 创建推文文本文件
                const tweetContent = [
                    `用户: @${tweet.user_name} (${tweet.user_display_name})`,
                    `时间: ${date.toLocaleString('zh-CN')}`,
                    `链接: ${tweet.url}`,
                    '',
                    '内容:',
                    tweet.full_text,
                    '',
                    `转发: ${tweet.retweet_count} | 喜欢: ${tweet.favorite_count} | 回复: ${tweet.reply_count}`,
                ].join('\n');

                files.push({
                    filename: `${folderName}/tweet.txt`,
                    content: tweetContent
                });

                // 处理媒体文件
                if (tweet.media && tweet.media.length > 0) {
                    // 处理所有媒体文件，不再限制数量
                    for (let i = 0; i < tweet.media.length; i++) {
                        try {
                            const media = tweet.media[i];

                            if (media && media.type === 'photo' && media.url) {
                                // 添加图片下载任务
                                files.push({
                                    filename: `${folderName}/image_${i + 1}.jpg`,
                                    url: media.url
                                });
                            }
                        } catch (mediaError) {
                            console.error(`处理推文媒体失败 (推文ID: ${tweet.id}, 媒体索引: ${i}):`, mediaError);
                            errorCount++;

                            // 添加错误信息
                            files.push({
                                filename: `${folderName}/media_${i + 1}_error.txt`,
                                content: `处理媒体文件时出错: ${mediaError.message || '未知错误'}\n时间: ${new Date().toLocaleString()}`
                            });
                        }
                    }

                    // 收集所有媒体链接（包括视频）
                    try {
                        const mediaLinks = tweet.media
                            .map((m, i) => m && m.url ? `${i + 1}. [${m.type || '未知'}] ${m.url}` : null)
                            .filter(Boolean)
                            .join('\n');

                        // 添加媒体链接文件
                        if (mediaLinks) {
                            files.push({
                                filename: `${folderName}/media_links.txt`,
                                content: `# 媒体链接\n${mediaLinks}\n\n# 推文链接\n${tweet.url}`
                            });
                        }
                    } catch (linksError) {
                        console.error(`处理媒体链接失败 (推文ID: ${tweet.id}):`, linksError);

                        // 添加一个基础的媒体链接文件
                        files.push({
                            filename: `${folderName}/media_links.txt`,
                            content: `# 媒体链接 (处理出错)\n原始推文: ${tweet.url}\n处理时间: ${new Date().toLocaleString()}`
                        });
                    }
                }
            } catch (tweetError) {
                console.error(`处理推文失败 (索引: ${processedCount - 1}):`, tweetError);
                errorCount++;

                // 为错误的推文添加错误信息文件
                try {
                    const errorFilename = `error_tweet_${tweet.id || Date.now()}.txt`;

                    files.push({
                        filename: errorFilename,
                        content: [
                            `处理推文失败: ${tweetError.message || '未知错误'}`,
                            `推文ID: ${tweet.id || '未知'}`,
                            `用户: ${tweet.user_name || '未知'}`,
                            `时间: ${new Date().toLocaleString()}`,
                            '',
                            '部分原始数据:',
                            JSON.stringify({
                                id: tweet.id,
                                user_name: tweet.user_name,
                                created_at: tweet.created_at,
                                url: tweet.url
                            }, null, 2)
                        ].join('\n')
                    });
                } catch (errorFileError) {
                    console.error('创建错误信息文件也失败了:', errorFileError);
                }
            }
        }

        console.log(`准备完成: 处理了${processedCount}条推文，生成${files.length}个文件，${errorCount}个错误`);

        return files;
    }

    // 纯文本导出
    async function handleTextExport() {
        if (isExporting || isAutoScrolling) {
            showMessage('正在处理中，请稍候...', 'warning');
            return;
        }

        // 获取目标日期
        const dateValue = document.getElementById('export-date-picker').value;
        targetDate = dateValue ? new Date(dateValue + 'T23:59:59') : null;

        const exportBtn = document.getElementById('text-export-button');
        exportBtn.classList.add('loading');
        exportBtn.innerHTML = '<div class="loading-spinner"></div><span>处理中...</span>';
        isExporting = true;

        try {
            // 自动滚动加载
            showMessage('开始智能加载推文...', 'info');
            await smartAutoScroll();

            // 筛选符合日期的推文
            let tweets = Array.from(capturedTweets.values());
            if (targetDate) {
                tweets = tweets.filter(tweet => {
                    const tweetDate = new Date(tweet.created_at);
                    return tweetDate >= targetDate;
                });
            }

            if (tweets.length === 0) {
                showMessage('未找到符合条件的推文', 'error');
                return;
            }

            // 创建文本内容
            const textContent = tweets.map(tweet => {
                const date = new Date(tweet.created_at);
                return `===== ${date.toLocaleString('zh-CN')} - @${tweet.user_name} =====\n${tweet.full_text}\n${tweet.url}\n\n`;
            }).join('\n');

            const mediaUrls = tweets.flatMap(tweet =>
                tweet.media.map(m => `${m.type}: ${m.url || ''}\n源自: ${tweet.url}`)
            ).join('\n\n');

            // 导出文本文件
            const blob = new Blob([
                textContent,
                '\n\n======= 媒体链接 =======\n\n',
                mediaUrls
            ], { type: 'text/plain;charset=utf-8' });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            saveAs(blob, `${currentUsername}_tweets_${timestamp}.txt`);

            showMessage(`成功导出 ${tweets.length} 条推文为文本文件`, 'success');

        } catch (error) {
            console.error('文本导出失败:', error);
            showMessage('文本导出失败，请查看控制台', 'error');
        } finally {
            isExporting = false;
            exportBtn.classList.remove('loading');
            exportBtn.innerHTML = '<span class="icon">📄</span><span>导出为文本</span>';
            updateProgress('');
        }
    }

    // 拦截XHR请求
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        // 保存原始URL供后续使用
        this._requestURL = url;
        this._requestMethod = method;

        this.addEventListener('load', function () {
            try {
                // 打印所有GraphQL请求用于调试
                if (this._requestURL && this._requestURL.includes('/graphql/')) {
                    console.log(`[XHR] ${this._requestMethod} ${this._requestURL}`);

                    // 尝试解析所有GraphQL响应
                    if (this.responseText) {
                        try {
                            const data = JSON.parse(this.responseText);

                            // 检查是否包含timeline数据
                            if (JSON.stringify(data).includes('timeline')) {
                                console.log('[XHR] 发现包含timeline的响应:', this._requestURL);
                                parseUserTweets(data);
                            }

                            // 检查是否包含tweet数据
                            if (JSON.stringify(data).includes('tweet_results')) {
                                console.log('[XHR] 发现包含tweet_results的响应:', this._requestURL);
                                parseUserTweets(data);
                            }
                        } catch (e) {
                            console.error('[XHR] 解析失败:', e);
                        }
                    }
                }
            } catch (e) {
                console.error('[XHR] 处理响应时出错:', e);
            }
        });

        return originalOpen.apply(this, arguments);
    };

    // 拦截Fetch API
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const [url, options] = args;
        const response = await originalFetch.apply(this, args);

        try {
            // 只处理字符串URL
            if (typeof url === 'string' && url.includes('/graphql/')) {
                console.log(`[Fetch] ${url}`);

                // 克隆响应以便读取
                const clonedResponse = response.clone();

                try {
                    const text = await clonedResponse.text();
                    if (text) {
                        const data = JSON.parse(text);

                        // 检查是否包含timeline数据
                        if (text.includes('timeline') || text.includes('tweet_results')) {
                            console.log('[Fetch] 发现推文数据:', url);
                            parseUserTweets(data);
                        }
                    }
                } catch (e) {
                    console.error('[Fetch] 解析失败:', e);
                }
            }
        } catch (e) {
            console.error('[Fetch] 处理响应时出错:', e);
        }

        return response;
    };

    // 尝试从页面获取初始数据
    function checkInitialData() {
        try {
            // 检查window对象中的初始数据
            if (window.__INITIAL_STATE__) {
                console.log('找到初始状态数据:', window.__INITIAL_STATE__);
            }

            // 检查React组件props
            const reactRoot = document.querySelector('#react-root');
            if (reactRoot && reactRoot._reactRootContainer) {
                console.log('找到React根容器');
            }

            // 手动触发一次滚动以激活数据加载
            setTimeout(() => {
                window.scrollBy(0, 100);
                setTimeout(() => {
                    window.scrollBy(0, -100);
                }, 500);
            }, 2000);
        } catch (e) {
            console.error('检查初始数据失败:', e);
        }
    }

    // 跟踪Twitter分页请求的光标
    const paginationInfo = {
        cursors: new Set(),
        lastCursor: null,
        totalPagesLoaded: 0,
        noNewDataCount: 0,
        addCursor(cursor) {
            if (!cursor) return false;

            // 检查是否是新光标
            const isNew = !this.cursors.has(cursor);
            if (isNew) {
                this.cursors.add(cursor);
                this.lastCursor = cursor;
                this.totalPagesLoaded++;
                this.noNewDataCount = 0;
                console.log(`[分页] 发现新光标: ${cursor.substring(0, 20)}... (总页数: ${this.totalPagesLoaded})`);
            } else {
                this.noNewDataCount++;
                console.log(`[分页] 重复光标 (${this.noNewDataCount}次): ${cursor.substring(0, 20)}...`);
            }
            return isNew;
        },
        reset() {
            this.cursors.clear();
            this.lastCursor = null;
            this.totalPagesLoaded = 0;
            this.noNewDataCount = 0;
            console.log('[分页] 重置分页跟踪');
        },
        hasReachedEnd() {
            // 如果连续3次收到相同光标，认为已经到达末尾
            return this.noNewDataCount >= 3;
        }
    };

    // 解析用户推文
    function parseUserTweets(data) {
        try {
            const initialTweetCount = capturedTweets.size;
            console.log(`[数据加载] 开始解析推文数据，当前已有 ${initialTweetCount} 条推文`);

            // 尝试多种可能的数据路径
            let instructions = [];

            // 路径1: user timeline
            if (data.data?.user?.result?.timeline?.timeline?.instructions) {
                instructions = data.data.user.result.timeline.timeline.instructions;
                console.log('[数据路径] 使用路径1: user timeline');
            }
            // 路径2: user_result timeline
            else if (data.data?.user_result?.result?.timeline?.timeline?.instructions) {
                instructions = data.data.user_result.result.timeline.timeline.instructions;
                console.log('[数据路径] 使用路径2: user_result timeline');
            }
            // 路径3: timeline_v2
            else if (data.data?.user?.result?.timeline_v2?.timeline?.instructions) {
                instructions = data.data.user.result.timeline_v2.timeline.instructions;
                console.log('[数据路径] 使用路径3: timeline_v2');
            }
            // 路径4: 直接的timeline
            else if (data.data?.timeline?.timeline?.instructions) {
                instructions = data.data.timeline.timeline.instructions;
                console.log('[数据路径] 使用路径4: 直接timeline');
            }
            // 路径5: home timeline
            else if (data.data?.home?.home_timeline_urt?.instructions) {
                instructions = data.data.home.home_timeline_urt.instructions;
                console.log('[数据路径] 使用路径5: home timeline');
            }

            if (instructions.length === 0) {
                console.log('[数据路径] 未找到有效的指令路径，数据结构:', JSON.stringify(data, null, 2).substring(0, 500));
                return;
            }

            console.log(`[数据加载] 解析到 ${instructions.length} 条指令`);

            // 处理推文计数器
            let processedEntries = 0;
            let addedTweets = 0;
            let foundCursors = 0;

            for (const instruction of instructions) {
                if (instruction.type === 'TimelineAddEntries' ||
                    instruction.type === 'TimelineAddToModule' ||
                    instruction.__typename === 'TimelineAddEntries') {
                    const entries = instruction.entries || [];
                    console.log(`[数据加载] 处理 ${entries.length} 个条目`);

                    for (const entry of entries) {
                        processedEntries++;

                        // 查找分页光标
                        if (entry.entryId && (
                            entry.entryId.includes('cursor-bottom') ||
                            entry.entryId.includes('cursor-showmore')
                        )) {
                            const cursor = entry.content?.value ||
                                entry.content?.itemContent?.value ||
                                null;

                            if (cursor) {
                                foundCursors++;
                                const isNewCursor = paginationInfo.addCursor(cursor);
                                console.log(`[分页] ${isNewCursor ? '新' : '重复'}光标: ${cursor.substring(0, 20)}...`);
                            }
                        }

                        // 支持多种推文ID格式
                        if (entry.entryId && (
                            entry.entryId.startsWith('tweet-') ||
                            entry.entryId.includes('tweet-') ||
                            entry.entryId.startsWith('sq-I-t-') ||
                            entry.entryId.includes('home-conversation-') ||
                            entry.entryId.includes('profile-conversation-')
                        )) {
                            const tweet = extractTweetData(entry);
                            if (tweet) {
                                const isNewTweet = !capturedTweets.has(tweet.id);
                                capturedTweets.set(tweet.id, tweet);
                                updateStats();
                                if (isNewTweet) {
                                    addedTweets++;
                                }
                            }
                        } else if (entry.content?.items) {
                            // 处理会话中的多条推文
                            for (const item of entry.content.items) {
                                if (item.entryId && item.entryId.includes('tweet-')) {
                                    const tweet = extractTweetData(item);
                                    if (tweet) {
                                        const isNewTweet = !capturedTweets.has(tweet.id);
                                        capturedTweets.set(tweet.id, tweet);
                                        updateStats();
                                        if (isNewTweet) {
                                            addedTweets++;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 检查是否有新推文被添加
            const newTweetCount = capturedTweets.size - initialTweetCount;
            console.log(`[数据加载] 本次解析处理了 ${processedEntries} 个条目，发现 ${foundCursors} 个光标，添加了 ${newTweetCount} 条新推文，当前总数: ${capturedTweets.size}`);

            // 检查是否达到分页末尾
            if (paginationInfo.hasReachedEnd() && newTweetCount === 0) {
                console.log('[分页] 检测到分页已到达末尾，无法加载更多推文');
                showMessage('已加载所有可用推文', 'info');

                // 停止自动滚动
                if (isAutoScrolling) {
                    isAutoScrolling = false;
                    updateProgress(`加载完成，共获取 ${capturedTweets.size} 条推文 (已到达末尾)`);
                }
            }

        } catch (e) {
            console.error('[错误] 解析推文列表失败:', e);
            console.error('[错误] 原始数据结构:', JSON.stringify(data, null, 2).substring(0, 500));
        }
    }

    // 提取推文数据
    function extractTweetData(entry) {
        try {
            // 尝试多种数据路径
            let result = null;

            // 路径1: 标准路径
            result = entry.content?.itemContent?.tweet_results?.result ||
                entry.item?.itemContent?.tweet_results?.result;

            // 路径2: 直接result
            if (!result && entry.content?.result) {
                result = entry.content.result;
            }

            // 路径3: tweet_results在不同位置
            if (!result && entry.tweet_results?.result) {
                result = entry.tweet_results.result;
            }

            if (!result) {
                console.log('未找到推文结果，entry结构:', JSON.stringify(entry, null, 2).substring(0, 300));
                return null;
            }

            // 处理被引用的推文（retweet）
            if (result.tweet) {
                result = result.tweet;
            }

            const tweet = result.legacy;
            if (!tweet) {
                console.log('未找到legacy数据，result结构:', JSON.stringify(result, null, 2).substring(0, 300));
                return null;
            }

            // 获取用户信息
            const user = result.core?.user_results?.result?.legacy ||
                result.user?.legacy ||
                result.user_results?.result?.legacy;

            if (!user) {
                console.log('未找到用户信息');
                return null;
            }

            // 提取媒体
            const media = [];
            if (tweet.extended_entities?.media || tweet.entities?.media) {
                const mediaList = tweet.extended_entities?.media || tweet.entities?.media;
                for (const m of mediaList) {
                    if (m.type === 'photo') {
                        media.push({
                            type: 'photo',
                            url: m.media_url_https + '?format=jpg',
                            thumb_url: m.media_url_https + '?format=jpg'
                        });
                    } else if (m.type === 'video' || m.type === 'animated_gif') {
                        const variants = m.video_info?.variants || [];
                        const mp4Variants = variants.filter(v => v.content_type === 'video/mp4');
                        const bestVariant = mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                        media.push({
                            type: m.type,
                            url: bestVariant?.url || variants[0]?.url,
                            thumb_url: m.media_url_https,
                            duration_ms: m.video_info?.duration_millis
                        });
                    }
                }
            }

            // 获取完整文本
            const fullText = result.note_tweet?.note_tweet_results?.result?.text ||
                tweet.full_text ||
                tweet.text;

            // 构建推文URL（兼容x.com）
            const tweetUrl = `https://x.com/${user.screen_name}/status/${tweet.id_str}`;

            const tweetData = {
                id: tweet.id_str,
                created_at: tweet.created_at,
                timestamp: new Date(tweet.created_at).getTime(),
                full_text: fullText,
                user_id: user.id_str,
                user_name: user.screen_name,
                user_display_name: user.name,
                retweet_count: tweet.retweet_count || 0,
                favorite_count: tweet.favorite_count || 0,
                reply_count: tweet.reply_count || 0,
                quote_count: tweet.quote_count || 0,
                bookmark_count: tweet.bookmark_count || 0,
                view_count: result.views?.count || tweet.view_count || 0,
                media: media,
                url: tweetUrl
            };

            console.log(`提取推文成功: ID=${tweetData.id}, 用户=@${tweetData.user_name}`);
            return tweetData;

        } catch (e) {
            console.error('提取推文数据失败:', e);
            console.error('Entry数据:', entry);
            return null;
        }
    }

    // 监听页面变化
    function observePageChanges() {
        let lastUrl = location.href;
        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                handlePageChange();
            }
        }).observe(document, { subtree: true, childList: true });
    }

    // 处理页面变化
    function handlePageChange() {
        if (isUserProfilePage()) {
            capturedTweets.clear();
            updateStats();
            showMessage(`开始捕获 @${currentUsername} 的推文`, 'info');

            // 重置分页跟踪
            paginationInfo.reset();
        }
    }

    // 初始化
    function init() {
        createUI();
        observePageChanges();

        if (isUserProfilePage()) {
            showMessage(`正在捕获 @${currentUsername} 的推文`, 'info');
            checkInitialData();
        }
    }

    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 1000);
    }
})();
