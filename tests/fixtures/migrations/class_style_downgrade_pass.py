class Migration:
    def upgrade(self):
        op.execute("select 1")

    def downgrade(self):
        pass
