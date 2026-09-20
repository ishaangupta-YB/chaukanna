# The drill agent for AgentCore Runtime.
#
# The contract this image has to meet (docs: runtime-http-protocol-contract):
#   platform linux/arm64, host 0.0.0.0, port 8080, WebSocket at /ws, health at /ping.
# The last three come from BedrockAgentCoreApp; the platform and the host are set here.
#
# Python 3.12 is a floor, not a preference: Nova Sonic's bidirectional stream fails confusingly
# on 3.11.
#
# Build and run it locally the same way AgentCore will:
#   docker build --platform linux/arm64 -t chaukanna-drill .
#   docker run --rm -p 8080:8080 --env-file .env.docker chaukanna-drill

FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # BedrockAgentCoreApp binds 127.0.0.1 unless it can tell it is containerised, and the
    # microVM has no /.dockerenv to tell it with. Without this the health check never passes.
    DOCKER_CONTAINER=1

WORKDIR /app

# Dependencies first, from the hash-pinned export of uv.lock, so a rebuild of the agent code
# does not silently pick up a different SDK than the one the tests ran against.
COPY requirements.lock ./
RUN pip install --require-hashes --no-deps -r requirements.lock

# Then the agent itself. `--no-deps` because the line above already resolved everything.
COPY pyproject.toml ./
COPY chaukanna_agent ./chaukanna_agent
RUN pip install --no-deps .

RUN useradd --create-home --uid 10001 drill
USER drill

EXPOSE 8080
CMD ["python", "-m", "chaukanna_agent.server"]
