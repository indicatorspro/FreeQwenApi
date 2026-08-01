from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

resp = client.chat.completions.create(
    model="qwen-max-latest",
    messages=[
        {"role": "system", "content": "You are a senior Python developer. Answer briefly and with a code example."},
        {"role": "user", "content": "How do I reverse a list in Python?"},
    ],
)

print(resp.choices[0].message.content)
