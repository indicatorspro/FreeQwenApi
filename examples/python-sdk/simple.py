from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

resp = client.chat.completions.create(
    model="qwen-max-latest",
    messages=[{"role": "user", "content": "Hello! Write a short greeting."}],
)

print(resp.choices[0].message.content)
