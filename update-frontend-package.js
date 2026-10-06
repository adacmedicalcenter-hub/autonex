const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, 'autonex-frontend', 'package.json');

try {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  // Add socket.io-client to dependencies
  if (!packageJson.dependencies) {
    packageJson.dependencies = {};
  }
  packageJson.dependencies['socket.io-client'] = '4.7.2';

  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2), 'utf8');
  console.log('✅ Updated package.json with socket.io-client dependency!');
  console.log('\nNext: Run "npm install" in the autonex-frontend folder');
} catch (error) {
  console.error('Error updating package.json:', error.message);
}