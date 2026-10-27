import { defineConfig } from 'vite';

// relative asset paths: the build works from any folder or sub-path (itch.io serves a game from one)
export default defineConfig({ base: './' });
