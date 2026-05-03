from fastapi import FastAPI, Request
from transformers import MarianMTModel, MarianTokenizer

app = FastAPI()

# Load model for English <-> Swahili
model_name = "Helsinki-NLP/opus-mt-en-swa"
tokenizer = MarianTokenizer.from_pretrained(model_name)
model = MarianMTModel.from_pretrained(model_name)

@app.post("/translate")
async def translate(request: Request):
    data = await request.json()
    text = data["text"]
    translated = model.generate(**tokenizer(text, return_tensors="pt", padding=True))
    result = tokenizer.decode(translated[0], skip_special_tokens=True)
    return {"translatedText": result}
