FROM mcr.microsoft.com/devcontainers/typescript-node:22

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

# Install AWS CDK CLI
RUN npm install -g aws-cdk

# Install Docker CLI (for CDK asset bundling)
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*
