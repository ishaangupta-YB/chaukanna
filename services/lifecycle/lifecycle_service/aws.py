"""Lazy boto3 clients and the table name.

Lazy for two reasons: a cold start that refuses the ring (paused member, outside window) never
pays to build an SES client it will not use, and a test can replace `client` with a fake without
touching the network or the credential chain.

The region is always read from the environment. `AWS_REGION` is set by the Lambda runtime and
points at the data region, `ap-south-1`; never hardcode it here.
"""

from __future__ import annotations

import os
from typing import Any

import boto3

_clients: dict[str, Any] = {}


def region() -> str:
    return os.environ.get("AWS_REGION", "ap-south-1")


def client(service: str) -> Any:
    cached = _clients.get(service)
    if cached is None:
        cached = boto3.client(service, region_name=region())
        _clients[service] = cached
    return cached


def ddb() -> Any:
    return client("dynamodb")


def sesv2() -> Any:
    return client("sesv2")


def table_name() -> str:
    return os.environ["TABLE_NAME"]
