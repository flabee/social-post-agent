# Official Puppeteer image: Chromium + deps already included (same version as package.json).
FROM ghcr.io/puppeteer/puppeteer:23.6.0

# System operations as root, then drop back to the unprivileged user.
USER root
WORKDIR /app

# Install only the dependencies (Chromium is already in the base image, not re-downloaded).
COPY package.json ./
RUN npm install --omit=dev

# Code + assets (fonts).
COPY . .

# The app runs as pptruser (the Puppeteer image's user).
RUN chown -R pptruser:pptruser /app
USER pptruser

ENV NODE_ENV=production
CMD ["node", "server.js"]
