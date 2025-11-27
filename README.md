# Chklstly Service

A Node.js service for managing Firebase user claims and AI suggestions.

## Features

- User trial management
- Premium subscription verification
- Push notifications
- AI suggestions using OpenAI GPT-4o (nano)

## Environment Variables

Required environment variables:

```bash
ADAPTY_API_KEY=your_adapty_api_key
OS_APP_ID=your_onesignal_app_id
OS_API_KEY=your_onesignal_api_key
OS_ANDROID_CHANNEL_ID=your_android_channel_id
ANDROID_PACKAGE_NAME=your_android_package_name
OPENAI_API_KEY=your_openai_api_key
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables
3. Start the service:
```bash
npm start
```

## Usage

The service runs on port 3000 by default. You can change this by setting the `PORT` environment variable.
