// Example of using the OpenAI SDK with the Qwen AI proxy - simple request
// Install: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Key is not used but required by the SDK
});

async function simpleRequest() {
    try {
        console.log('Sending a request to Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Write 5 interesting facts about space' }
            ],
            model: 'qwen-max-latest',
        });

        console.log('Response from Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nRequest completed successfully.');

    } catch (error) {
        console.error('Error during request:', error);
    }
}

// Run
simpleRequest();
