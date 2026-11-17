"""``/api/auth`` (sign in and out, first admin, own password) and ``/api/users`` (the Users tab)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from ..auth import COOKIE, SESSION_SECONDS, TABS, AuthError, LockedOut, SetupDone, User, UserStore, UsersFileError

router = APIRouter(prefix="/api/auth", tags=["auth"])
users_router = APIRouter(prefix="/api/users", tags=["users"])


def get_users(request: Request) -> UserStore:
    return request.app.state.users


def auth_enabled(request: Request) -> bool:
    return request.app.state.settings.auth


def current_user(request: Request) -> User | None:
    return get_users(request).user_for(request.cookies.get(COOKIE))


def require_user(request: Request) -> User:
    user = current_user(request)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in first")
    return user


def require_admin(request: Request) -> User:
    if not auth_enabled(request):
        raise HTTPException(status.HTTP_409_CONFLICT, "Users are off (PROOFLIX_AUTH)")
    user = require_user(request)
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can manage users")
    return user


def _bad(e: AuthError) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e))


class Credentials(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current: str
    new: str


class AuthStatus(BaseModel):
    enabled: bool  # PROOFLIX_AUTH
    setup_needed: bool  # no users yet: the login page creates the first admin
    user: dict | None  # {username, role, tabs, visible_tabs, ...}
    tabs: list[str]  # every tab a user can be given


def _sign_in(response: Response, request: Request, user: User) -> None:
    response.set_cookie(
        COOKIE,
        get_users(request).issue(user),
        max_age=SESSION_SECONDS,
        httponly=True,  # not readable by page scripts
        samesite="lax",  # not sent with cross-site POSTs
        secure=request.url.scheme == "https",
        path="/",
    )


def _users_file_error(e: UsersFileError) -> HTTPException:
    return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e))


@router.get("/status", response_model=AuthStatus)
def auth_status(request: Request) -> AuthStatus:
    store = get_users(request)
    if not auth_enabled(request):
        return AuthStatus(enabled=False, setup_needed=False, user=None, tabs=list(TABS))
    try:
        user = current_user(request)
        setup_needed = store.setup_needed
    except UsersFileError as e:
        raise _users_file_error(e) from None
    return AuthStatus(enabled=True, setup_needed=setup_needed, user=user.public() if user else None, tabs=list(TABS))


@router.post("/setup", response_model=AuthStatus)
def setup(body: Credentials, request: Request, response: Response) -> AuthStatus:
    """Create the first admin; refused once any user exists."""
    store = get_users(request)
    if not auth_enabled(request):
        raise HTTPException(status.HTTP_409_CONFLICT, "Users are off (PROOFLIX_AUTH)")
    try:
        store.create_first_admin(body.username, body.password)  # refused once any user exists
        user = store.authenticate(body.username, body.password)  # records the first sign-in
    except UsersFileError as e:
        raise _users_file_error(e) from None
    except SetupDone as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    except AuthError as e:
        raise _bad(e) from None
    _sign_in(response, request, user)
    return AuthStatus(enabled=True, setup_needed=False, user=user.public(), tabs=list(TABS))


@router.post("/login", response_model=AuthStatus)
def login(body: Credentials, request: Request, response: Response) -> AuthStatus:
    try:
        user = get_users(request).authenticate(body.username, body.password)
    except LockedOut as e:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(e),
                            headers={"Retry-After": str(e.retry_after)}) from None
    except UsersFileError as e:
        raise _users_file_error(e) from None
    except AuthError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(e)) from None
    _sign_in(response, request, user)
    return AuthStatus(enabled=True, setup_needed=False, user=user.public(), tabs=list(TABS))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response) -> Response:
    response.delete_cookie(COOKIE, path="/")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/password", response_model=AuthStatus)
def change_password(body: PasswordChange, request: Request, response: Response) -> AuthStatus:
    """Change your own password; you stay signed in, other sessions end."""
    user = require_user(request)
    try:
        user = get_users(request).change_own_password(user.username, body.current, body.new)
    except AuthError as e:
        raise _bad(e) from None
    _sign_in(response, request, user)
    return AuthStatus(enabled=True, setup_needed=False, user=user.public(), tabs=list(TABS))


# ------------------------------------------------------------ users (admins)
class NewUser(BaseModel):
    username: str
    password: str
    role: str = "user"
    tabs: list[str] = []


class UserChange(BaseModel):
    role: str | None = None
    tabs: list[str] | None = None
    password: str | None = None  # a new password (reset); None keeps it
    disabled: bool | None = None


@users_router.get("")
def list_users(store: UserStore = Depends(get_users), admin: User = Depends(require_admin)) -> list[dict]:
    return [u.public() for u in store.list()]


@users_router.post("", status_code=status.HTTP_201_CREATED)
def create_user(body: NewUser, store: UserStore = Depends(get_users),
                admin: User = Depends(require_admin)) -> dict:
    try:
        return store.create(body.username, body.password, body.role, body.tabs).public()
    except AuthError as e:
        raise _bad(e) from None


@users_router.put("/{username}")
def update_user(username: str, body: UserChange, request: Request, response: Response,
                store: UserStore = Depends(get_users), admin: User = Depends(require_admin)) -> dict:
    try:
        user = store.update(username, actor=admin.username, role=body.role, tabs=body.tabs,
                            password=body.password or None, disabled=body.disabled)
        if user.username == admin.username and body.password:
            _sign_in(response, request, user)  # your own new password: stay signed in here
        return user.public()
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No user {username}") from None
    except AuthError as e:
        raise _bad(e) from None


@users_router.delete("/{username}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(username: str, store: UserStore = Depends(get_users),
                admin: User = Depends(require_admin)) -> Response:
    try:
        store.delete(username, actor=admin.username)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No user {username}") from None
    except AuthError as e:
        raise _bad(e) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
