FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOSTNAME=0.0.0.0
CMD ["npm", "start"]
