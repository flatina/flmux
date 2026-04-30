// Bun's text-import attribute (`import x from "./y" with { type: "text" }`)
// returns the file's contents as a string. TS needs an ambient declaration
// to know about asset extensions used with that attribute.
declare module "*.svg" {
  const content: string;
  export default content;
}
