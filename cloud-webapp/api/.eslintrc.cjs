/* eslint-env node */

/**
 * The provider seam (AZURE_MIGRATION_DEV_PLAN.md D10).
 *
 * One codebase serves both clouds, which only works while the provider SDKs stay
 * behind their adapters: `lib/db/` owns Firestore and Cosmos, `lib/storage/`
 * owns GCS and Blob, `lib/googleCredentials.ts` owns how we prove who we are to
 * Google. Prose said so from the start and the code has held — this makes a
 * violation fail CI instead of relying on everyone remembering.
 *
 * It matters most at decommission: deleting the GCP half is a safe, mechanical
 * job exactly as long as every import of it sits in a file we are deleting.
 *
 * Exceptions are per-directory overrides below, never an inline disable — an
 * exception should be visible in one place when the seam is next audited.
 */
const PROVIDER_SDKS = [
  { name: '@google-cloud/firestore', message: 'Firestore belongs in lib/db/ (D10). Use firestore() from lib/firestore.js.' },
  { name: '@google-cloud/storage', message: 'GCS belongs in lib/storage/ (D10). Use the storage adapter.' },
  { name: '@azure/cosmos', message: 'Cosmos belongs in lib/db/ (D10). Use firestore() from lib/firestore.js.' },
  { name: '@azure/storage-blob', message: 'Blob belongs in lib/storage/ (D10). Use the storage adapter.' },
  { name: '@azure/identity', message: 'Azure credentials belong in lib/ (D10).' },
];

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    'no-restricted-imports': ['error', { paths: PROVIDER_SDKS }],
  },
  overrides: [
    {
      // The adapters themselves — this is the whole point of them.
      files: ['src/lib/db/**/*.ts', 'src/lib/storage/**/*.ts', 'src/lib/googleCredentials.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      // Tests may import an SDK to build a fake or assert a call shape.
      files: ['test/**/*.ts', 'src/**/*.test.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/'],
};
