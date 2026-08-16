HomeNode monorepo containing frontend (dcad-frontend), server (server), and backend (dcad-backend).

Frontend:
cd dcad-frontend
npm install
npm run dev

Server:
cd server
npm install
npm run start

Do not commit .env files.

## Contributing

`main` is production-bound. Create a branch and open a pull request; do not
push feature work directly to `main`. See [CONTRIBUTING.md](CONTRIBUTING.md).

UAD 3.6 work must also follow the accepted integration boundary and second
worker handoff:

- [UAD integration boundary](docs/architecture/ADR-001-uad-integration-boundary.md)
- [UAD second-worker handoff](docs/uad/SECOND_WORKER_HANDOFF.md)
