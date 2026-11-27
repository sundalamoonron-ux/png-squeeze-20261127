# PNG Squeeze — png-squeeze-01-run-20261127

[![make.fun competition](https://img.shields.io/badge/make.fun-competition-7c3aed)](https://make.fun/c/png-squeeze-01-run-20261127)
[![make.fun leaderboard](https://img.shields.io/badge/make.fun-leaderboard-7c3aed)](https://make.fun/c/png-squeeze-01-run-20261127/leaderboard)
[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/c/png-squeeze-01-run-20261127)

A lossless PNG compressor that squeezes screenshots into the smallest possible PNG. Entry for the make.fun competition [png-squeeze-01-run-20261127](https://make.fun/c/png-squeeze-01-run-20261127).

## How it works

`main.ts` reads the competition screenshots, re-encodes each one losslessly, and writes the smallest valid PNG to `/output`. Run it with Node 22:

```sh
node main.ts
```
