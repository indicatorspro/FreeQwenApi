// Example of using the OpenAI SDK with a system message
// Install: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Key is not used but required by the SDK
});

async function systemMessageExample() {
    try {
        console.log('Sending a request with a system message to Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: 'You are an experienced astronomer specializing in the planets of the Solar System. Answer with scientific accuracy but in plain language.'
                },
                {
                    role: 'user',
                    content: 'Tell me about Mars and its features'
                }
            ],
            model: 'qwen-max-latest',
        });

        console.log('Response from Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nRequest with system message completed successfully.');

    } catch (error) {
        console.error('Error during request:', error);
    }
}

// Run
systemMessageExample();
