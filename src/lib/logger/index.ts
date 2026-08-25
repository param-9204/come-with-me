type LogContext = Record<string, unknown>;

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack:
        process.env.NODE_ENV === 'production'
          ? undefined
          : error.stack,
    };
  }

  return error;
}

function write(
  level: 'info' | 'warn' | 'error' | 'debug',
  event: string,
  context?: LogContext
) {
  const log = {
    timestamp: new Date().toISOString(),
    level,
    event,
    environment: process.env.NODE_ENV,
    ...context,
  };

  if (level === 'error') {
    console.error(JSON.stringify(log));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(log));
  } else if (level === 'debug') {
    console.debug(JSON.stringify(log));
  } else {
    console.log(JSON.stringify(log));
  }
}

export const logger = {
  info(event: string, context?: LogContext) {
    write('info', event, context);
  },

  warn(event: string, context?: LogContext) {
    write('warn', event, context);
  },

  error(
    event: string,
    context?: LogContext & { error?: unknown }
  ) {
    write('error', event, {
      ...context,
      error: context?.error
        ? serializeError(context.error)
        : undefined,
    });
  },

  debug(event: string, context?: LogContext) {
    if (process.env.NODE_ENV !== 'production') {
      write('debug', event, context);
    }
  },
};