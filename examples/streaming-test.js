// Example of using the streaming API via /api/chat
// Run: node examples/streaming-test.js

async function testStreaming() {
    console.log('🧪 Testing REAL streaming via /api/chat\n');
    console.log('📡 Waiting for the first chunk...\n');

    const startTime = Date.now();
    let firstChunkTime = null;

    const response = await fetch('http://localhost:3264/api/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: 'Tell a short story about space (5-7 sentences)',
            model: 'qwen-max-latest',
            stream: true
        })
    });

    if (!response.ok) {
        console.error(`❌ HTTP error: ${response.status}`);
        return;
    }

    console.log('✅ Response received, starting stream read...\n');
    console.log('📝 Response text:\n');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let chunkCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;
            if (line === 'data: [DONE]') {
                const endTime = Date.now();
                console.log('\n\n✅ Streaming complete');
                console.log(`📊 Statistics:`);
                console.log(`   - Chunks received: ${chunkCount}`);
                console.log(`   - Time to first chunk: ${firstChunkTime - startTime}ms`);
                console.log(`   - Total time: ${endTime - startTime}ms`);
                console.log(`   - Response length: ${fullContent.length} characters`);
                console.log(`   - Average speed: ${Math.round(fullContent.length / ((endTime - firstChunkTime) / 1000))} chars/sec`);
                return;
            }

            try {
                const jsonStr = line.substring(6).trim();
                if (!jsonStr) continue;

                const chunk = JSON.parse(jsonStr);
                const content = chunk.choices?.[0]?.delta?.content || '';
                if (content) {
                    if (!firstChunkTime) {
                        firstChunkTime = Date.now();
                    }
                    chunkCount++;
                    process.stdout.write(content);
                    fullContent += content;
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }

    console.log(`\n\n📊 Full response (${fullContent.length} characters)`);
}

testStreaming().catch(console.error);
