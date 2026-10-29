// Keep native import() outside Pi's Jiti transform, which otherwise ignores URL versions.
export const importModule = (url) => import(url);
