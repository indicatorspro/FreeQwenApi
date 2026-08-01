const BASE_URL = 'http://localhost:3264/api';

async function testChat() {
    console.log('\n=== Test: Text chat (t2t) ===');
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Name the capital of France.',
                model: 'qwen-max-latest'
            })
        });

        const data = await response.json();
        if (data.error) {
            console.log('ERROR:', data.error);
            return false;
        }
        console.log('OK:', data.choices[0].message.content.substring(0, 100));
        return true;
    } catch (error) {
        console.log('ERROR:', error.message);
        return false;
    }
}

async function testImageGeneration() {
    console.log('\n=== Test: Image generation (t2i) ===');
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Beautiful sunset over a calm ocean with orange and pink clouds',
                model: 'qwen3-vl-plus',
                chatType: 't2i',
                size: '16:9'
            })
        });

        const data = await response.json();
        if (data.error) {
            console.log('ERROR:', data.error);
            return false;
        }
        console.log('OK:', data.choices[0].message.content.substring(0, 120));
        return true;
    } catch (error) {
        console.log('ERROR:', error.message);
        return false;
    }
}

async function testVideoGeneration() {
    console.log('\n=== Test: Video generation (t2v) ===');
    console.log('(may take 1-2 minutes)');
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Quiet forest, sunbeams passing through the trees',
                model: 'qwen3-vl-plus',
                chatType: 't2v',
                size: '16:9'
            })
        });

        const data = await response.json();
        if (data.error) {
            console.log('ERROR:', data.error);
            return false;
        }
        console.log('OK:', data.video_url || data.choices[0].message.content.substring(0, 120));
        return true;
    } catch (error) {
        console.log('ERROR:', error.message);
        return false;
    }
}

async function main() {
    console.log('==============================');
    console.log(' FreeQwenApi Feature Tests');
    console.log('==============================');

    const chat = await testChat();
    const image = await testImageGeneration();
    const video = await testVideoGeneration();

    console.log('\n==============================');
    console.log(' Results');
    console.log('==============================');
    console.log('Chat (t2t):', chat ? 'OK' : 'ERROR');
    console.log('Image (t2i):', image ? 'OK' : 'ERROR');
    console.log('Video (t2v):', video ? 'OK' : 'ERROR');
    console.log('==============================\n');

    process.exit(chat && image && video ? 0 : 1);
}

main();
