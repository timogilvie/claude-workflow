revision = "009"
down_revision = "008"

from alembic import op


def upgrade():
    statement = "op.drop_table('users') and op.execute('UPDATE users SET x = 1')"
    op.execute("CREATE VIEW widget_names AS SELECT 'drop_table' AS warning_text")
    return statement


def downgrade():
    pass
