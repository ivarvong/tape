// host/problem.ts: an error as application/problem+json (RFC 9457), the shape of every error the service answers
// for itself and of std/http.tape's `problem`, so a client reads one shape whoever said no:
//   {"type": "about:blank", "title": <the status's reason phrase>, "status": <status>, "detail": <what went wrong>,
//    …members}
// `type` is about:blank (the status says what kind of failure it is), and `title` is then the status's phrase. The
// members after `detail` are RFC 9457's extension members: what a client acts on (`outcome` and `retry`, `errors`,
// a key's version). No Node APIs: the host runs in workerd and the browser.

/** The media type of a problem. */
export const PROBLEM_TYPE = 'application/problem+json';

/** The reason phrase RFC 9110 (and the IANA registry) gives each 4xx and 5xx; std/http.tape status_title holds the
 * same table (test/problem.ts compares them). */
export const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  511: 'Network Authentication Required',
};

/** A status's title: its phrase, or the class of a 4xx or 5xx the table does not name. */
export const titleOf = (status: number): string =>
  TITLES[status] ??
  (status >= 400 && status < 500 ? 'Client Error' : status >= 500 && status < 600 ? 'Server Error' : 'Error');

/** The members of a problem, in RFC 9457's order, then the extension members. */
export type Problem = {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  [member: string]: unknown;
};

/** A problem's body. A member named like one of the problem's own (type, title, status, detail) is dropped: those
 * say what the problem is, and an extension cannot change them. */
export function problemOf(status: number, detail: string, members: Readonly<Record<string, unknown>> = {}): Problem {
  const rest = Object.fromEntries(
    Object.entries(members).filter(([k, v]) => !['type', 'title', 'status', 'detail'].includes(k) && v !== undefined),
  );
  return { type: 'about:blank', title: titleOf(status), status, detail, ...rest };
}

/** A problem's body as the bytes a host sends. */
export const problemBytes = (status: number, detail: string, members?: Readonly<Record<string, unknown>>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(problemOf(status, detail, members)));

/** Whether a body is a problem: an object whose type, title, status and detail are there and of their kinds. */
export const isProblem = (v: unknown): v is Problem =>
  typeof v === 'object' &&
  v !== null &&
  'type' in v &&
  typeof v.type === 'string' &&
  'title' in v &&
  typeof v.title === 'string' &&
  'status' in v &&
  typeof v.status === 'number' &&
  'detail' in v &&
  typeof v.detail === 'string';
