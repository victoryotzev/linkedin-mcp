// CSS is imported for its side effect so esbuild bundles it into app.css next
// to app.js. TypeScript needs to be told the module exists.
declare module '*.css';
