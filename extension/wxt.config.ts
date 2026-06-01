import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  // Don't auto-launch a temp Chrome — load the extension manually in your real browser
  runner: { disabled: true },
  vite: () => ({
    // Cast needed: @tailwindcss/vite vendors its own Vite, WXT vendors a different one;
    // types diverge on hotUpdate but the plugin works correctly at runtime.
    plugins: [tailwindcss() as any],
  }),
  manifest: {
    name: 'Milkr',
    description: 'Best way to pay at every checkout — credit, debit, BNPL, or virtual card.',
    version: '0.1.0',
    permissions: ['storage', 'activeTab', 'scripting'],
    host_permissions: ['https://*/*'],
    action: {
      default_popup: 'popup.html',
    },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Ctrl+Shift+H', mac: 'Command+Shift+H' },
        description: 'Open Milkr',
      },
    },
  },
});
