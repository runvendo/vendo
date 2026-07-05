/** Vite `?inline` CSS imports (used by sandbox bundle builds) resolve to the
 *  stylesheet source as a string. */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
