// Example demonstrating OpenAI API compatibility
// Install: npm install openai

import OpenAI from 'openai';

// Configure the OpenAI client using our proxy as the endpoint
const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Key is not used but required by the SDK
});

async function openaiCompatibilityExample() {
    try {
        console.log('Demonstrating OpenAI API compatibility\n');

        // 1. Standard request in OpenAI format
        console.log('1. Standard request in OpenAI format...');

        const completion = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that gives brief and clear answers.' },
                { role: 'user', content: 'What is artificial intelligence?' }
            ],
            temperature: 0.7,
        });

        console.log('Response:');
        console.log(completion.choices[0].message.content);

        // 2. Streaming request in OpenAI format
        console.log('\n2. Streaming request in OpenAI format...');

        console.log('Response (streaming mode):');
        const stream = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that answers briefly.' },
                { role: 'user', content: 'List the 5 most popular programming languages' }
            ],
            stream: true,
        });

        let streamedContent = '';
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            streamedContent += content;
            process.stdout.write(content);
        }
        console.log('\n');

        // 3. Demonstration of the OpenAI-format response structure
        console.log('\n3. OpenAI-format response structure:');

        const responseDemo = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [{ role: 'user', content: 'Hello!' }],
        });

        // Print the response structure (without message content)
        const { choices, ...responseWithoutChoices } = responseDemo;
        console.log(JSON.stringify({
            ...responseWithoutChoices,
            choices: [{
                ...choices[0],
                message: { role: choices[0].message.role, content: '[message content hidden for brevity]' }
            }]
        }, null, 2));



    } catch (error) {
        console.error('Error running example:', error);
    }
}

// Run
openaiCompatibilityExample();
