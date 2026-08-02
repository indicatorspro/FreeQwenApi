#!/usr/bin/env node
/**
 * Test script to simulate MCP tool call and see detailed logs
 */

const API_URL = 'http://localhost:3264/api';
const MEDIA_DIR = 'C:\\VAULT-AI\\CUEN\\generated';

async function testImageGeneration() {
    console.log('[TEST] Starting image generation test...\n');
    
    const prompt = 'Um gato laranja dormindo em uma almofada azul';
    const model = 'qwen-image-max';
    const size = '16:9';
    
    console.log('[TEST] Calling proxy with:');
    console.log(`  - prompt: ${prompt}`);
    console.log(`  - model: ${model}`);
    console.log(`  - size: ${size}`);
    console.log();
    
    try {
        const res = await fetch(`${API_URL}/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, size, model })
        });

        console.log(`[TEST] Proxy response status: ${res.status}`);
        
        if (!res.ok) {
            const body = await res.text();
            console.error(`[TEST] Proxy error: ${body}`);
            process.exit(1);
        }

        const data = await res.json();
        console.log('[TEST] Proxy response structure:', JSON.stringify(data, null, 2));
        
        const url = data.data?.[0]?.url;
        if (!url) {
            console.error('[TEST] No URL in response');
            process.exit(1);
        }
        
        console.log(`\n[TEST] Image URL: ${url}`);
        console.log(`\n[TEST] Now testing download and save...`);
        
        // Test download
        const downloadRes = await fetch(url);
        if (!downloadRes.ok) {
            console.error(`[TEST] Download failed: ${downloadRes.status}`);
            process.exit(1);
        }
        
        const buffer = await downloadRes.arrayBuffer();
        console.log(`[TEST] Downloaded ${(buffer.byteLength / 1024).toFixed(2)} KB`);
        
        // Test save
        const fs = await import('fs');
        const path = await import('path');
        
        if (!fs.existsSync(MEDIA_DIR)) {
            console.log(`[TEST] Creating directory: ${MEDIA_DIR}`);
            fs.mkdirSync(MEDIA_DIR, { recursive: true });
        }
        
        const filename = `test-${Date.now()}.png`;
        const fullPath = path.join(MEDIA_DIR, filename);
        
        fs.writeFileSync(fullPath, Buffer.from(buffer));
        console.log(`[TEST] Saved to: ${fullPath}`);
        
        // Verify file exists
        if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            console.log(`[TEST] File verified: ${(stats.size / 1024).toFixed(2)} KB`);
        }
        
        console.log('\n[TEST] ✅ All tests passed!');
        
    } catch (error) {
        console.error('[TEST] Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testImageGeneration();
