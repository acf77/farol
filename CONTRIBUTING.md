# Contributing to Farol

Thanks for helping. Bug reports, fixes, and small improvements are all welcome.

## Before you start

- **Bugs:** [open an issue](https://github.com/acf77/farol/issues) with what you did, what you expected, and what happened. Include your macOS version, the Farol version, and which agent CLI you used.
- **Features and larger changes:** open an issue first so we can agree on the approach before you spend time on it.

## Set up

You need an Apple Silicon Mac, Node 22, and Git.

```bash
git clone https://github.com/acf77/farol.git
cd farol/app
npm install
npm run dev
```

[`app/README.md`](app/README.md) explains how the app is put together.

## Make a change

1. Branch from `main`.
2. Keep the change focused. One fix or feature per pull request.
3. Match the code around you: naming, comments, and structure.
4. Use the product's words. [`CONTEXT.md`](CONTEXT.md) defines them.
5. For anything you can see, follow [`DESIGN.md`](DESIGN.md).
6. Add or update tests for behavior you change.

Before you open the pull request, run:

```bash
cd app
npm run typecheck
npm test
```

## Pull requests

Say what changed and why, and how you tested it. Add a screenshot for UI changes. Keep commits readable; they don't need to be squashed.

## Security

If you find a security issue, please don't open a public issue. [Report it privately](https://github.com/acf77/farol/security/advisories/new) through GitHub instead.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
