import json
import os.path as osp

from fastapi import APIRouter

router = APIRouter(prefix="/orders")


def read_orders(path: str) -> list:
    with open(osp.join(path, "orders.json")) as f:
        return json.load(f)


@router.get("")
def list_orders() -> list:
    if not osp.exists("data"):
        return []
    return read_orders("data")
