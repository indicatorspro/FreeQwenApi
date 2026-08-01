const BASE_URL = 'http://localhost:3264/api';

async function testServerSidePolling() {
    console.log('\n=== Mode 1: Server-side polling (waitForCompletion=true) ===');
    console.log('Server waits for completion on its own...');

    const start = Date.now();

    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Peaceful mountain landscape with flowing rivers',
                model: 'qwen3-vl-plus',
                chatType: 't2v',
                size: '16:9',
                waitForCompletion: true
            })
        });

        const data = await response.json();
        const sec = ((Date.now() - start) / 1000).toFixed(1);

        if (data.error) {
            console.log(`ERROR (${sec}s): ${data.error}`);
            return { ok: false, sec };
        }

        const url = data.video_url || data.choices?.[0]?.message?.content;
        console.log(`OK (${sec}s): ${url}`);
        return { ok: true, sec };
    } catch (e) {
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`ERROR (${sec}s): ${e.message}`);
        return { ok: false, sec };
    }
}

async function testClientSidePolling() {
    console.log('\n=== Mode 2: Client-side polling (waitForCompletion=false) ===');
    console.log('Server returns task_id immediately, client polls on its own...');

    const start = Date.now();

    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Quiet forest, sunbeams passing through the trees',
                model: 'qwen3-vl-plus',
                chatType: 't2v',
                size: '16:9',
                waitForCompletion: false
            })
        });

        const taskData = await response.json();
        const reqSec = ((Date.now() - start) / 1000).toFixed(1);

        if (!taskData.task_id) {
            console.log(`ERROR (${reqSec}s): task_id not received`);
            return { ok: false, sec: reqSec };
        }

        console.log(`Task created in ${reqSec}s, task_id: ${taskData.task_id}`);

        const taskId = taskData.task_id;
        const maxAttempts = 90;
        const interval = 2000;

        for (let i = 1; i <= maxAttempts; i++) {
            await new Promise(r => setTimeout(r, interval));

            const statusResp = await fetch(`${BASE_URL}/tasks/status/${taskId}`);
            const statusData = await statusResp.json();
            const sec = ((Date.now() - start) / 1000).toFixed(1);

            if (statusData.error) {
                console.log(`  [${i}/${maxAttempts}] (${sec}s) Error: ${statusData.error}`);
                continue;
            }

            const status = statusData.task_status || statusData.status;
            console.log(`  [${i}/${maxAttempts}] (${sec}s) ${status}`);

            if (status === 'completed' || status === 'succeeded') {
                const url = statusData.content || statusData.data?.content;
                console.log(`OK (${sec}s, ${i} attempts): ${url}`);
                return { ok: true, sec, attempts: i };
            }

            if (status === 'failed' || status === 'error') {
                console.log(`ERROR (${sec}s): task failed`);
                return { ok: false, sec, attempts: i };
            }
        }

        const sec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`TIMEOUT (${sec}s, ${maxAttempts} attempts)`);
        return { ok: false, sec, timeout: true };
    } catch (e) {
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`ERROR (${sec}s): ${e.message}`);
        return { ok: false, sec };
    }
}

async function main() {
    console.log('==============================================');
    console.log(' Video generation polling comparison test');
    console.log('==============================================');

    const server = await testServerSidePolling();

    console.log('\n--- Pausing 5 sec before the next test ---\n');
    await new Promise(r => setTimeout(r, 5000));

    const client = await testClientSidePolling();

    console.log('\n==============================================');
    console.log(' Results');
    console.log('==============================================');
    console.log(`Server-side polling: ${server.ok ? 'OK' : 'ERROR'} (${server.sec}s)`);
    console.log(`Client-side polling: ${client.ok ? 'OK' : 'ERROR'} (${client.sec}s)`);
    console.log('==============================================\n');

    process.exit(server.ok || client.ok ? 0 : 1);
}

main();
