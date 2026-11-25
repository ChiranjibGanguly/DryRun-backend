import { checkProductionConfig, config } from './config.js';
import { createApp } from './app.js';

const problems = checkProductionConfig();
if (problems.length) {
  console.error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
if (!config.isProduction && process.env.ADMIN_PASSWORD === 'Admin@12345') {
  console.warn('Note: the admin password is still the default. Change it before going live.');
}

createApp().listen(config.port, () => {
  console.log(`API running on http://localhost:${config.port}`);
});
