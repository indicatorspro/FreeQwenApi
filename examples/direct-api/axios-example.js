// Example of a direct request to the Qwen proxy API using axios
// Install: npm install axios
// To run: node axios-example.js

import axios from 'axios';

async function axiosExample() {
    try {
        console.log('Sending a request via axios to the Qwen API...\n');

        // Example with OpenAI-compatible messages format
        const response = await axios.post('http://localhost:3264/api/chat', {
            messages: [
                { role: 'system', content: 'You are a JavaScript programming expert.' },
                { role: 'user', content: 'Explain how asynchronous functions work in JavaScript' }
            ],
            model: 'qwen-max-latest'
        });

        console.log('Response from API:\n');
        console.log(response.data.choices[0].message.content);
        console.log('\nRequest completed successfully.');

        // Print additional information
        console.log('\nRequest info:');
        console.log(`Chat ID: ${response.data.chatId}`);
        console.log(`Model: ${response.data.model}`);

        // Save the chat ID for the next example
        const chatId = response.data.chatId;

        // Continue the conversation in the same chat
        console.log('\n\nSending a second message to the same chat...\n');

        const followUpResponse = await axios.post('http://localhost:3264/api/chat', {
            message: 'Give an example of using async/await',
            model: 'qwen-max-latest',
            chatId: chatId
        });

        console.log('Response to the second message:\n');
        console.log(followUpResponse.data.choices[0].message.content);

    } catch (error) {
        console.error('Error during request:', error);
        if (error.response) {
            console.error('Error details:', error.response.data);
        }
    }
}

// Run
axiosExample();
