export class AppError extends Error {
  constructor({ title, status, detail, code, errors = [] }) {
    super(detail);
    this.name = this.constructor.name;
    this.title = title;
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
  }
}

export class ValidationError extends AppError {
  constructor(detail, errors = []) {
    super({ title: 'Validation Error', status: 422, detail, code: 'validation-error', errors });
  }
}

export class BadRequestError extends AppError {
  constructor(detail = '请求无效。', code = 'bad-request') {
    super({ title: 'Bad Request', status: 400, detail, code });
  }
}

export class NotFoundError extends AppError {
  constructor(resource) {
    super({ title: 'Not Found', status: 404, detail: `${resource} 不存在。`, code: 'not-found' });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super({ title: 'Payload Too Large', status: 413, detail: '请求内容过大。', code: 'payload-too-large' });
  }
}

export class MalformedJsonError extends AppError {
  constructor() {
    super({ title: 'Malformed JSON', status: 400, detail: '请求体不是有效的 JSON。', code: 'malformed-json' });
  }
}
