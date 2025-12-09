# GenGui Core - Media Storage API

Multi-tenant media storage API for GenGui platform.

## Setup

```bash
npm install
cp .env.example .env
```

## Development

```bash
npm run dev        # Start dev server with hot reload
npm run build      # Build for production
npm run start      # Run production build
npm run typecheck  # Run TypeScript type checking
npm run lint       # Run ESLint
npm run lint:fix   # Run ESLint with auto-fix
npm run format     # Format code with Prettier
```

## Project Structure

```
src/
├── config/        # Configuration and environment variables
├── middleware/    # Express middleware
├── models/        # Data models (TBD)
├── routes/        # API route handlers
├── services/      # Business logic services (TBD)
├── app.ts         # Express app setup
└── index.ts       # Server entry point
```

## API Endpoints

### Health Check
`GET /api/health` - Returns server status and timestamp

## Tech Stack

- TypeScript
- Express.js
- Zod (env validation)
- ESLint + Prettier
