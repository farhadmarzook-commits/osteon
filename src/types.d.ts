declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "sql.js/dist/sql-wasm-browser.js" {
  import initSqlJs from "sql.js";
  export default initSqlJs;
}
