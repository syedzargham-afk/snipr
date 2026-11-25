## Summary
Describe the changes made in this PR.

## Checklist
- [ ] Tested `npm run build:renderer` with zero errors
- [ ] Verified `node -c` syntax checks on `electron/*.js` and `extension/*.js`
- [ ] Confirmed no binaries (`/bin`, `/release`), `userData` files, or auth tokens are committed
- [ ] Preserved Electron security boundaries (`contextIsolation`, `sandbox`, `X-Snipr-Token`)
