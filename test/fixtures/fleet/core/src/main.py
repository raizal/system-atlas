from fastapi import FastAPI

from src.api.router import router
from src.config import settings

app = FastAPI()
app.include_router(router, prefix=settings.api_v1_str)
