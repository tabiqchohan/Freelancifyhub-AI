export default {
  '*.{ts,mts,cts}': ['eslint --fix', 'prettier --write'],
  '*.{js,mjs,cjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,jsonc,json5,md,yaml,yml}': ['prettier --write'],
};
