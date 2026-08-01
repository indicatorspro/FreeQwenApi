// Example of a direct request to the Qwen proxy API using fetch
// To run: node fetch-example.js

async function directApiRequest() {
    try {
        console.log('Sending a direct request to the Qwen API...\n');

        const response = await fetch('http://localhost:3264/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: 'Explain in simple terms what artificial intelligence is',
                model: 'qwen-max-latest'
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const result = await response.json();

        console.log('Response from API:\n');
        console.log(result.choices[0].message.content);
        console.log('\nRequest completed successfully.');

        // Print additional information
        console.log('\nRequest info:');
        console.log(`Chat ID: ${result.chatId}`);
        console.log(`Model: ${result.model}`);

    } catch (error) {
        console.error('Error during request:', error);
    }
}

// Run
directApiRequest();
