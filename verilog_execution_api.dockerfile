# Use a lightweight Linux image with Node.js installed
FROM node:18-alpine

# Install Icarus Verilog compiler
RUN apk update && apk add --no-cache iverilog

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY server.js ./

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD [ "npm", "start" ]