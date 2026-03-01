# CloudClips

Serverless short video sharing platform built on AWS.

## Stack

- **Frontend**: React + Vite, hosted on S3 + CloudFront (`cloudclips.sokech.com`)
- **Backend**: AWS Lambda (Node.js 20), API Gateway, DynamoDB, S3
- **Transcoding**: AWS Elemental MediaConvert (360p + 720p outputs)
- **AI Moderation**: AWS Rekognition Video + Amazon Transcribe (auto-captions)
- **Auth**: AWS Cognito
- **IaC**: AWS CDK (TypeScript)
- **CI/CD**: GitHub Actions with OIDC federation (no stored AWS keys)

## Monorepo Structure

```
infra/       # CDK stacks
backend/     # Lambda handlers + shared utilities
frontend/    # React SPA
scripts/     # One-time AWS setup helpers
```

## Development

```bash
pnpm install          # Install all dependencies
pnpm typecheck        # Typecheck all workspaces
pnpm lint             # Lint all workspaces
cd infra && npx cdk synth   # Synthesize CloudFormation templates
cd frontend && pnpm dev     # Start frontend dev server
```

## Deployment

Pushes to `main` automatically deploy via GitHub Actions.

For first-time setup, see `scripts/` for CDK bootstrap, OIDC federation, and DNS helpers.
