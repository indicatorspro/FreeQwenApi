from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

chat_id = None
parent_id = None

first = client.chat.completions.create(
    model="qwen-max-latest",
    messages=[{"role": "user", "content": "My name is Alex. Remember that."}],
)
print("Assistant:", first.choices[0].message.content)

if hasattr(first, "chatId"):
    chat_id = first.chatId
if hasattr(first, "parentId"):
    parent_id = first.parentId

second_messages = [{"role": "user", "content": "What is my name?"}]
extra_body = {}
if chat_id:
    extra_body["chatId"] = chat_id
if parent_id:
    extra_body["parentId"] = parent_id

second = client.chat.completions.create(
    model="qwen-max-latest",
    messages=second_messages,
    extra_body=extra_body or None,
)
print("Assistant:", second.choices[0].message.content)
