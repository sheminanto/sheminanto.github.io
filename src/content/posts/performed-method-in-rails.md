---
title: "performed? in Rails"
description: "A short note on using performed? to check whether a Rails action has already rendered or redirected."
date: 2026-09-04
tags: [rails, controllers]
---

Rails controller actions usually end with one response. That response might be a `render`, a `redirect_to`, or the default template Rails renders for the action.

Sometimes the response can happen inside a helper method. In those cases, the action may need to stop before it tries to render again.

Rails gives us `performed?` for that.

```ruby
def show
  render_error_if_missing_user
  return if performed?

  render json: { success: true }
end
```

`performed?` returns true when the controller has already performed a response.

## Why it matters

Rails does not allow an action to render or redirect twice.

This kind of code can break:

```ruby
def show
  render_error_if_missing_user

  render json: { success: true }
end
```

If `render_error_if_missing_user` already called `render`, the final `render` will try to send a second response. Rails will raise an error.

Using `return if performed?` makes the control flow explicit:

```ruby
def show
  render_error_if_missing_user
  return if performed?

  render json: { success: true }
end
```

Now the action only continues when no response has been sent yet.

## A simple example

```ruby
class UsersController < ApplicationController
  def show
    find_user_or_render_error
    return if performed?

    render json: { id: @user.id, name: @user.name }
  end

  private

  def find_user_or_render_error
    @user = User.find_by(id: params[:id])

    return if @user

    render json: { error: "User not found" }, status: :not_found
  end
end
```

The private method handles the error response. The action checks `performed?` before rendering the success response.

## Keep it readable

`performed?` is useful, but it should not hide complicated controller flow. If many helper methods can render or redirect, the action can become hard to follow.

Use it when it makes the intent clear: "stop here if a response already happened."

The short version: `performed?` helps a Rails controller avoid rendering twice after another method has already rendered or redirected.
