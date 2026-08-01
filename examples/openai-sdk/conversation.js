// Example of using the OpenAI SDK for a multi-message conversation
// Install: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Key is not used but required by the SDK
});

async function conversationExample() {
    try {
        console.log('Starting a conversation with Qwen AI...\n');

        // First user message
        console.log('User: Hello! Tell me about quantum physics in simple terms.');

        let completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Hello! Tell me about quantum physics in simple terms.' }
            ],
            model: 'qwen-max-latest',
        });

        const assistantResponse1 = completion.choices[0].message.content;
        console.log('\nQwen:', assistantResponse1);

        // Second user message, including conversation history
        console.log('\nUser: And how is this related to the theory of relativity?');

        completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Hello! Tell me about quantum physics in simple terms.' },
                { role: 'assistant', content: assistantResponse1 },
                { role: 'user', content: 'And how is this related to the theory of relativity?' }
            ],
            model: 'qwen-max-latest',
        });

        const assistantResponse2 = completion.choices[0].message.content;
        console.log('\nQwen:', assistantResponse2);

        // Third user message
        console.log('\nUser: Thank you! Which scientists made the greatest contribution to the development of these theories?');

        completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Hello! Tell me about quantum physics in simple terms.' },
                { role: 'assistant', content: assistantResponse1 },
                { role: 'user', content: 'And how is this related to the theory of relativity?' },
                { role: 'assistant', content: assistantResponse2 },
                { role: 'user', content: 'Thank you! Which scientists made the greatest contribution to the development of these theories?' }
            ],
            model: 'qwen-max-latest',
        });

        console.log('\nQwen:', completion.choices[0].message.content);
        console.log('\nConversation completed successfully.');

    } catch (error) {
        console.error('Error during conversation:', error);
    }
}

// Run
conversationExample();
