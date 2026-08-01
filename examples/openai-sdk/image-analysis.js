// Example of using the OpenAI SDK for image analysis
// Install: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Key is not used but required by the SDK
});

// IMPORTANT: Replace IMAGE_URL with a real image URL obtained from the Qwen interface
// See README.md, section "Getting an image URL from the Qwen interface"
const IMAGE_URL = "https://cdn.qwenlm.ai/bf6238a3-4578-49d6-b4a9-516e8a5eb27b/c88bc915-6ae7-4057-9bf9-1185c9141a0a_image.png?key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXNvdXJjZV91c2VyX2lkIjoiYmY2MjM4YTMtNDU3OC00OWQ2LWI0YTktNTE2ZThhNWViMjdiIiwicmVzb3VyY2VfaWQiOiJjODhiYzkxNS02YWU3LTQwNTctOWJmOS0xMTg1YzkxNDFhMGEiLCJyZXNvdXJjZV9jaGF0X2lkIjpudWxsfQ.qPvHr4fq23IgzxmxOyFJuFcVL0AJlpGgPlWB8BHkrlo";

async function analyzeImage() {
    try {
        console.log('Sending image request to Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Describe in detail what is shown in this image'
                        },
                        {
                            type: 'image',
                            image: IMAGE_URL
                        }
                    ]
                }
            ],
            model: 'qwen3-235b-a22b', // Using a model with image support
        });

        console.log('Response from Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nImage analysis completed successfully.');

    } catch (error) {
        console.error('Error during image request (make sure the image size does not exceed 10MB):', error);
    }
}

// Run
analyzeImage();
