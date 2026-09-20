"""Lazily constructed, region explicit boto3 clients.

Lazy so a task that never speaks to Polly does not pay to build a Polly client, and so a test can
replace `client` with a fake without touching the network or the credential chain. Explicit region
because `DATA_REGION` is the only thing that decides where these calls go (see config.py).
"""

from __future__ import annotations

from typing import Any

import boto3

from . import config

_clients: dict[str, Any] = {}


def region() -> str:
    return config.data_region()


def client(service: str) -> Any:
    cached = _clients.get(service)
    if cached is None:
        cached = boto3.client(service, region_name=region())
        _clients[service] = cached
    return cached


def reset() -> None:
    """Drop the cache. Only the CLI and tests need this, when the region changes mid process."""
    _clients.clear()


def ddb() -> Any:
    return client("dynamodb")


def s3() -> Any:
    return client("s3")


def bedrock() -> Any:
    return client("bedrock-runtime")


def polly() -> Any:
    return client("polly")
