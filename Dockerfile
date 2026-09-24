# Use Node LTS
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy project sources and generate Prisma client
COPY . .
RUN npx prisma generate

# Build app
RUN npm run build

# Keep only production dependencies
RUN npm prune --production

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "run", "start:prod"]
