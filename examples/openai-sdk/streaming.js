// Example of using the OpenAI SDK with the Qwen AI proxy in streaming mode
// Install: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key',
});

async function streamFromQwen() {
    try {
        console.log('Sending a streaming request to Qwen AI...\n');


        const stream = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Write a short story about space travel' }
            ],
            model: 'qwen-max-latest',
            stream: true,
        });

        console.log('Response from Qwen (streaming mode):\n');

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            process.stdout.write(content);
        }

        console.log('\n\nStreaming response complete.');

    } catch (error) {
        console.error('Error during streaming request:', error);
    }
}

// Run
streamFromQwen();
