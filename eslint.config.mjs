import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  {
    // These React Compiler rules ship as errors in eslint-config-next 16 but flag
    // animation code written for React 18 (imperative spring refs). Keep them
    // visible as warnings until the animation hooks are refactored.
    rules: {
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'src-tauri/target/**', 'legacy/**']),
]);
